#!/usr/bin/env bash
# webui-smoke.sh — phase 15 验收标准「WebUI 本地起服务：HTTP 200 于 index、SSE feed 端点冒烟」
#
# 为什么是脚本而不是 vitest 用例：验收标准明写「curl 脚本断言」。单元测试在进程内驱动
# router，证明不了「真的监听了一个端口、真的能被外部进程用 HTTP 取到东西」。这里起的是
# 真实 node:http 服务，用真实 curl 打它。
#
# 用构建产物（dist/）而非源码：与 `./pie` 启动器同一口径，也顺带证明 `npm run build`
# 的产物是自洽的。
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
PORT_FILE="$(mktemp)"
LOG="$(mktemp)"
export PORT_FILE
trap 'kill "${SRV:-0}" 2>/dev/null || true; rm -f "$PORT_FILE" "$LOG" /tmp/webui-index.html /tmp/webui-sse.h /tmp/webui-sse.body' EXIT

node --input-type=module -e '
import { AsyncQueue } from "@pie/agent-core";
import { App } from "./packages/coding-agent/dist/ui/index.js";
import { runWeb } from "./packages/coding-agent/dist/ui/web.js";
import { registryWithBuiltins } from "./packages/coding-agent/dist/core/slash-dispatch.js";
import { HistoryStore } from "./packages/coding-agent/dist/history.js";

// Same shape as test/ported/ui-app.test.ts:testHarness — no model, no credentials, no network.
const harness = {
  getModel: () => undefined,
  getThinkingLevel: () => "off",
  session: () => ({ id: "smoke" }),
  skills: () => [],
  templates: () => [],
  async prompt() { return ""; },
  async abort() { return { clearedSteer: [], clearedFollowUp: [] }; },
  runEvaluator: async () => ({}),
};

const app = new App({
  harness, commandHarness: harness,
  registry: registryWithBuiltins(),
  cwd: ".", sessionId: "smoke", toolCount: 0,
  history: HistoryStore.loadFrom("/nonexistent-pie-history"),
  pendingImages: [],
  feedRx: new AsyncQueue(),
  mainRunRx: new AsyncQueue(),
  // Field names are the serde wire names (snake_case) — see test/ported/ui-app.test.ts:90.
  panelStatus: {
    mcp_servers: 0, mcp_tools: 0, mcp_server_names: [], mcp_tool_names: [],
    tool_names: [], mcp_notification_hooks: 0, hook_points: [], trigger_features: [],
  },
  catalog: () => [],
});

app.systemLine("webui smoke: hello from the ported feed");

// runWeb is the port of App::run_web and does not return until shutdown, so the port is
// read from the line it prints itself -- that line is oracle output, not a test affordance.
// (No apostrophes or backticks in this block: it lives inside a single-quoted shell string.)
await runWeb(app, { host: "127.0.0.1", port: 0, open: false });
' > "$LOG" 2>&1 &
SRV=$!

for _ in $(seq 100); do
  # `|| true`: with `set -e -o pipefail` a grep miss on the first iterations would otherwise
  # kill the script silently, before any assertion has a chance to print.
  PORT="$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$LOG" 2>/dev/null | head -1 | sed 's/.*://' || true)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
if [ -z "$PORT" ]; then echo "FAIL: server never reported a port"; cat "$LOG"; exit 1; fi
BASE="http://127.0.0.1:$PORT"
echo "server listening on $BASE"

fail=0

echo "--- 1) GET / → 200 text/html, serves web_index.html byte-for-byte ---"
code=$(curl -s -o /tmp/webui-index.html -w '%{http_code}' "$BASE/")
ctype=$(curl -s -o /dev/null -D - "$BASE/" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')
echo "HTTP $code   Content-Type: $ctype"
[ "$code" = "200" ] || { echo "FAIL: expected 200"; fail=1; }
case "$ctype" in text/html*) ;; *) echo "FAIL: expected text/html"; fail=1 ;; esac
if cmp -s /tmp/webui-index.html "$REPO_ROOT/packages/coding-agent/src/ui/web_index.html"; then
  echo "PASS: body byte-identical to src/ui/web_index.html ($(wc -c < /tmp/webui-index.html) bytes)"
else
  echo "FAIL: served body differs from web_index.html"; fail=1
fi

echo "--- 2) SSE /events → 200 text/event-stream, delivers a snapshot on publish ---"
# Oracle's `events` handler ONLY subscribes to the broadcast (web.rs:683-701); it does NOT
# replay a snapshot on connect, so an idle app legitimately sends nothing. Asserting "a frame
# arrives within N seconds on a quiet app" would be asserting a behaviour oracle does not have.
# Instead: hold the stream open, then poke an endpoint that publishes, and assert delivery.
curl -s --max-time 6 -D /tmp/webui-sse.h "$BASE/events" > /tmp/webui-sse.body 2>/dev/null &
SSE_PID=$!
sleep 0.5
curl -s -o /dev/null -X POST -H 'content-type: application/json' \
     -d '{"text":"smoke publish"}' "$BASE/prompt" || true
wait "$SSE_PID" 2>/dev/null || true
sse="$(cat /tmp/webui-sse.body 2>/dev/null || true)"
scode=$(awk 'NR==1{print $2}' /tmp/webui-sse.h)
sctype=$(tr -d '\r' < /tmp/webui-sse.h | awk -F': ' 'tolower($1)=="content-type"{print $2}')
scache=$(tr -d '\r' < /tmp/webui-sse.h | awk -F': ' 'tolower($1)=="cache-control"{print $2}')
echo "HTTP $scode   Content-Type: $sctype   Cache-Control: $scache"
[ "$scode" = "200" ] || { echo "FAIL: expected 200"; fail=1; }
case "$sctype" in text/event-stream*) ;; *) echo "FAIL: expected text/event-stream"; fail=1 ;; esac
if printf '%s' "$sse" | grep -q '^event: snapshot$'; then
  echo "PASS: saw 'event: snapshot' frame"
else
  echo "FAIL: no snapshot frame delivered after publish"; fail=1
fi
if printf '%s' "$sse" | grep -q 'webui smoke: hello from the ported feed'; then
  echo "PASS: pre-boot feed line present in the delivered snapshot payload"
else
  echo "FAIL: feed line missing from snapshot"; fail=1
fi

echo "--- 3) unknown path → 404 (axum fallback) ---"
nf=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/no-such-route")
echo "HTTP $nf"
[ "$nf" = "404" ] || { echo "FAIL: expected 404"; fail=1; }

echo
if [ "$fail" -eq 0 ]; then echo "WEBUI SMOKE: PASS"; else echo "WEBUI SMOKE: FAIL"; cat "$LOG"; fi
exit "$fail"
