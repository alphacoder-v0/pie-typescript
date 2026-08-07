#!/usr/bin/env bash
# test-live.sh — 用**真实 provider 凭据**跑测试套件。
#
# 与 test.sh 的关系：
#   test.sh      密闭。unset 全部 47 个 provider 变量 + PI_NO_LOCAL_LLM=1。
#                这是 `npm test`，也是 CI 与 phase 门禁用的那个——它必须能在无凭据的机器上跑通。
#   test-live.sh 本文件。**保留**环境里已有的凭据，让 credential-gated 的用例真正执行。
#
# 为什么不把这套直接变成 `npm test` 的默认行为：
#   1. 会花钱，而且不是小钱。仅 `packages/ai/test/context-overflow.test.ts` 一个用例就要发送
#      超过模型上下文上限的输入来触发溢出，实测一次即打满 Gemini 账号 1,000,000 tokens/分钟
#      的配额并拿到 429。默认门禁不该每次运行都烧钱。
#   2. 结果不确定。上游会退役模型（gemini-2.0-flash 已 404）、会限流、会超时——这些都不是
#      移植缺陷，却会让默认门禁变成掷骰子。
#   3. 无凭据的机器（CI、干净环境回归、`npm ci` 复现）必须仍能跑通全套。
#   所以：密闭那套是**门禁**，这套是**证据**。两者都要，角色不同。
#
# 用法：
#   bash test-live.sh              # 全部 workspace
#   bash test-live.sh packages/ai  # 只跑一个包
set -euo pipefail

export PI_NO_LOCAL_LLM=1

echo "=== test-live: 使用真实 provider 凭据 ==="
found=0
for v in ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY AZURE_OPENAI_API_KEY GEMINI_API_KEY \
         GOOGLE_API_KEY DEEPSEEK_API_KEY GROQ_API_KEY CEREBRAS_API_KEY XAI_API_KEY OPENROUTER_API_KEY \
         ZAI_API_KEY MISTRAL_API_KEY MINIMAX_API_KEY MOONSHOT_API_KEY KIMI_API_KEY HF_TOKEN \
         FIREWORKS_API_KEY TOGETHER_API_KEY AI_GATEWAY_API_KEY OPENCODE_API_KEY CLOUDFLARE_API_KEY \
         COPILOT_GITHUB_TOKEN AWS_ACCESS_KEY_ID AWS_BEARER_TOKEN_BEDROCK; do
  # 只报告变量**名**，绝不打印值。
  if [ -n "${!v:-}" ]; then echo "  detected: $v"; found=$((found+1)); fi
done
if [ "$found" -eq 0 ]; then
  echo "  (环境里一个 provider 凭据都没有 —— 本次运行等价于 test.sh，live 用例照旧 skip)"
fi
echo
echo "!! 这会向真实 provider 发请求并产生真实费用。"
echo "!! 已知高开销用例：packages/ai/test/context-overflow.test.ts 需要发送超过上下文上限的输入，"
echo "!! 单次即可打满 1,000,000 tokens/分钟 的配额。"
echo

if [ $# -gt 0 ]; then
  exec npx vitest run --root "$1"
fi
npm run test --workspaces --if-present
npm run test:workers
