/**
 * s345-probe.mts — the S3, S4 and S5 probes on the TypeScript side, the harness-level parity of pilot
 * unit A in phase 5.
 * It goes through the real provider entry point, streamOpenAIResponses, against a local SSE fixture
 * over HTTP,
 * and emits three lines of JSON, one each for S3, S4 and S5, which the compare script aligns against
 * the values captured upstream.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamOpenAIResponses } from "../../../packages/ai/src/providers/openai-responses.ts";
import type { Context, Model, AssistantMessage } from "../../../packages/ai/src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "lib", "sse-fixture-server.mjs");

function makeModel(port: number, compat: Record<string, unknown> | undefined): Model<"openai-responses"> {
  return {
    id: "gpt-5.2", name: "fixture", api: "openai-responses", provider: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: true,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000, maxTokens: 8192, ...(compat ? { compat } : {}),
  } as unknown as Model<"openai-responses">;
}

async function startFixture(mode: string, logPath: string): Promise<{ port: number; kill: () => void }> {
  const portFile = join(mkdtempSync(join(tmpdir(), "probe-")), "port");
  const child = spawn("node", [serverPath], {
    env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_PORT_FILE: portFile, FIXTURE_LOG: logPath },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    if (existsSync(portFile)) { const p = Number(readFileSync(portFile, "utf8")); if (p) return { port: p, kill: () => child.kill() }; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("fixture didn't start");
}

async function runTurn(
  model: Model<"openai-responses">,
  context: Context,
  extra?: { reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" },
): Promise<AssistantMessage> {
  const stream = streamOpenAIResponses(model, context, { apiKey: "dummy-fixture-key", ...extra });
  return await stream.result();
}

const tmp = mkdtempSync(join(tmpdir(), "probe-logs-"));

// ---- S3: usage accounting ----
{
  const log = join(tmp, "s3.ndjson");
  const f = await startFixture("usage", log);
  try {
    const msg = await runTurn(makeModel(f.port, undefined), {
      systemPrompt: "probe system prompt", messages: [{ role: "user", content: "hello fixture", timestamp: 0 } as never],
    });
    console.log(JSON.stringify({ scenario: "S3", usage: msg.usage, text: msg.content }));
  } finally { f.kill(); }
}

// ---- S4: retry on 409 ----
{
  const log = join(tmp, "s4.ndjson");
  const f = await startFixture("http409-once", log);
  try {
    const msg = await runTurn(makeModel(f.port, undefined), {
      systemPrompt: "probe system prompt", messages: [{ role: "user", content: "hello retry", timestamp: 0 } as never],
    });
    const reqs = readFileSync(log, "utf8").trim().split("\n").map((l) => { const j = JSON.parse(l); return { n: j.n, auth: j.auth, path: j.path }; });
    const text = (msg.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("");
    console.log(JSON.stringify({ scenario: "S4", reqs, finalText: text }));
  } finally { f.kill(); }
}

// ---- S5: reasoning replay, with compat on, over two turns ----
{
  const log = join(tmp, "s5.ndjson");
  const f = await startFixture("reasoning", log);
  try {
    const model = makeModel(f.port, { requiresReasoningContentOnAssistantMessages: true });
    const ctx: Context = { systemPrompt: "probe system prompt", messages: [{ role: "user", content: "first turn", timestamp: 0 } as never] };
    // reasoningEffort: "low" mirrors the oracle harness's `--thinking low` CLI flag
    // (migration/parity/scenarios/s5-reasoning-replay.sh) so the captured `reasoning`/`include`
    // top-level keys are directly comparable, not just the `input` array.
    const first = await runTurn(model, ctx, { reasoningEffort: "low" });
    ctx.messages.push(first as never);
    ctx.messages.push({ role: "user", content: "second turn", timestamp: 0 } as never);
    await runTurn(model, ctx, { reasoningEffort: "low" });
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const second = lines.find((j) => j.n === 2);
    const seq = (second?.body?.input ?? []).map((it: { role?: string; type?: string }) => ({ role: it.role ?? null, type: it.type ?? null }));
    console.log(JSON.stringify({ scenario: "S5", n: second?.n ?? null, seq }));
    console.log(JSON.stringify({ scenario: "S5-body", body: second?.body ?? null }));
  } finally { f.kill(); }
}
