#!/usr/bin/env node
// sse-fixture-server.mjs — an OpenAI-compatible fixture provider (Responses and Chat Completions SSE).
// Environment variables:
//   FIXTURE_PORT       the port to listen on (0 picks one at random; the actual port is written to
//                      FIXTURE_PORT_FILE)
//   FIXTURE_PORT_FILE  where to write that port
//   FIXTURE_LOG        the request log, NDJSON with {n, path, auth, body} per request
//   FIXTURE_MODE       usage | usage-mutated | http409-once | reasoning | tools
//   FIXTURE_SCRIPT_FILE  (MODE=tools) path to the JSON script described below
// Behavior:
//   usage:         completes one SSE turn with usage = {input:100, cached:80, cache_write:20,
//                  output:10, total:110}, the audit probe's accounting
//   usage-mutated: the same, but cached=0 and total 110 becomes 30 — the behavioral mutation used
//                  by the self-check
//   http409-once:  answers the first request with 409, then behaves like usage
//   reasoning:     emits output containing a reasoning item, for asserting the replay sequence; the
//                  request bodies are recorded in the log
//   tools:         **function_call scripted by request number** (phase 19). The nth request takes
//                  script[min(n-1, len-1)]. A step carrying tools emits a function_call item and sets
//                  stop_reason=ToolUse; the agent runs the tool and sends request n+1 carrying the
//                  function_call_output. A text-only step ends the turn, so the last step has to be
//                  text-only or the loop never terminates.
//
// The tools script format is a JSON array with one element per turn:
//   [ { "text": "optional leading text", "tools": [ { "name": "read", "arguments": { "path": "/abs/p" } } ] },
//     { "text": "the final reply" } ]
//
// Where the wire format comes from — **it is not guesswork**:
// packages/ai/src/providers/openai-responses-shared.ts
//   :357-368  output_item.added(item.type=="function_call") -> ToolCall{ id: `${call_id}|${id}` }
//   :469-497  function_call_arguments.delta and .done map to partialJson and the final arguments
//   :525-548  output_item.done(function_call) -> toolcall_end
//   :607-608  a function_call present in response.output at response.completed gives stopReason "toolUse"
// Upstream (crates/ai/src/providers/openai_responses.rs) **ignores response.output_item.done entirely**
//   (:294 `"response.output_item.done" => {}`). Its ToolCall.arguments can only come from
//   function_call_arguments.done (:496-511), and stop_reason from openai_stop_reason (:523-529).
//   So both sides have to be fed: output_item.added, arguments.delta, arguments.done,
//   output_item.done, and response.completed with a function_call inside output. Miss any one of
//   them and one side spins doing nothing.
//
// usage is all zeros in tools mode: this group of scenarios (S9 through S12) judges the tool
// execution chain, and the declared usage and cost divergences D1 and D2 are asserted by S3 and S6.
// Reporting zero here keeps one already-declared difference from reddening four scenarios over
// again; it is not there to make anything green. The negative control, the BREAK switch, proves
// these scenarios can still go red.
import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const MODE = process.env.FIXTURE_MODE || "usage";
const LOG = process.env.FIXTURE_LOG || "/dev/null";
let reqN = 0;

const SCRIPT = (() => {
  if (MODE !== "tools") return null;
  const p = process.env.FIXTURE_SCRIPT_FILE;
  if (!p) throw new Error("FIXTURE_MODE=tools requires FIXTURE_SCRIPT_FILE");
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("fixture script must be a non-empty array");
  return parsed;
})();

function usageObj() {
  if (MODE === "usage-mutated")
    return { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: {}, total_tokens: 110, cache_creation_input_tokens: 0 };
  return { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 10, output_tokens_details: {}, total_tokens: 110, cache_creation_input_tokens: 20 };
}
// tools mode: expands one script step into a sequence of events. The ids are built from the request
// number and are therefore deterministic across runs — normalize.mjs does not mask them, so they
// have to be stable to begin with, or the self-diff is non-zero immediately.
function toolStepEvents(step, n) {
  const respId = `resp_fixture_r${n}`;
  const events = [];
  const outputItems = [];
  let idx = 0;
  events.push(["response.created", { type: "response.created", response: { id: respId, status: "in_progress", output: [] } }]);
  if (step.text) {
    const msgId = `msg_fixture_r${n}`;
    const item = { type: "message", id: msgId, role: "assistant", content: [{ type: "output_text", text: step.text }] };
    events.push(["response.output_item.added", { type: "response.output_item.added", output_index: idx,
      item: { type: "message", id: msgId, role: "assistant", content: [] } }]);
    events.push(["response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, output_index: idx, delta: step.text }]);
    events.push(["response.output_item.done", { type: "response.output_item.done", output_index: idx, item }]);
    outputItems.push(item);
    idx++;
  }
  for (const [i, tc] of (step.tools || []).entries()) {
    const itemId = `fc_fixture_r${n}_${i}`;
    const callId = `call_fixture_r${n}_${i}`;
    const args = JSON.stringify(tc.arguments ?? {});
    events.push(["response.output_item.added", { type: "response.output_item.added", output_index: idx,
      item: { type: "function_call", id: itemId, call_id: callId, name: tc.name, arguments: "", status: "in_progress" } }]);
    events.push(["response.function_call_arguments.delta", { type: "response.function_call_arguments.delta",
      item_id: itemId, output_index: idx, delta: args }]);
    events.push(["response.function_call_arguments.done", { type: "response.function_call_arguments.done",
      item_id: itemId, output_index: idx, arguments: args }]);
    const done = { type: "function_call", id: itemId, call_id: callId, name: tc.name, arguments: args, status: "completed" };
    events.push(["response.output_item.done", { type: "response.output_item.done", output_index: idx, item: done }]);
    outputItems.push(done);
    idx++;
  }
  events.push(["response.completed", { type: "response.completed",
    response: { id: respId, status: "completed", usage: zeroUsage(), output: outputItems } }]);
  return events;
}
function zeroUsage() {
  return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0,
    output_tokens_details: {}, total_tokens: 0, cache_creation_input_tokens: 0 };
}
function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    reqN++;
    let parsed = null; try { parsed = JSON.parse(body); } catch {}
    appendFileSync(LOG, JSON.stringify({ n: reqN, path: req.url, method: req.method,
      auth: req.headers.authorization ? "present" : "absent", body: parsed }) + "\n");
    if (MODE === "http409-once" && reqN === 1) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "conflict, retry", type: "conflict" } }));
      return;
    }
    if (MODE === "tools") {
      sse(res, toolStepEvents(SCRIPT[Math.min(reqN - 1, SCRIPT.length - 1)], reqN));
      return;
    }
    const id = "resp_fixture001";
    const events = [];
    events.push(["response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }]);
    if (MODE === "reasoning") {
      events.push(["response.output_item.added", { type: "response.output_item.added", output_index: 0,
        item: { type: "reasoning", id: "rs_fixture001", summary: [] } }]);
      events.push(["response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: "rs_fixture001", delta: "thinking about it" }]);
      events.push(["response.output_item.done", { type: "response.output_item.done", output_index: 0,
        item: { type: "reasoning", id: "rs_fixture001", summary: [{ type: "summary_text", text: "thinking about it" }], encrypted_content: "opaque-blob-abc" } }]);
    }
    events.push(["response.output_item.added", { type: "response.output_item.added", output_index: 1,
      item: { type: "message", id: "msg_fixture001", role: "assistant", content: [] } }]);
    events.push(["response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_fixture001", delta: "fixture says hi" }]);
    events.push(["response.output_item.done", { type: "response.output_item.done", output_index: 1,
      item: { type: "message", id: "msg_fixture001", role: "assistant",
        content: [{ type: "output_text", text: "fixture says hi" }] } }]);
    events.push(["response.completed", { type: "response.completed",
      response: { id, status: "completed", usage: usageObj(),
        output: [{ type: "message", id: "msg_fixture001", role: "assistant",
          content: [{ type: "output_text", text: "fixture says hi" }] }] } }]);
    sse(res, events);
  });
});
server.listen(Number(process.env.FIXTURE_PORT || 0), "127.0.0.1", () => {
  const port = server.address().port;
  if (process.env.FIXTURE_PORT_FILE) writeFileSync(process.env.FIXTURE_PORT_FILE, String(port));
  console.log(`fixture listening :${port} mode=${MODE}`);
});
