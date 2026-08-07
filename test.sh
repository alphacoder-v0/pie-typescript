#!/usr/bin/env bash
set -e

AUTH_FILE="$HOME/.pie/auth.json"
AUTH_BACKUP="$HOME/.pie/auth.json.bak"

# Restore auth.json on exit (success or failure)
cleanup() {
    if [[ -f "$AUTH_BACKUP" ]]; then
        mv "$AUTH_BACKUP" "$AUTH_FILE"
        echo "Restored auth.json"
    fi
}
trap cleanup EXIT

# Move auth.json out of the way
if [[ -f "$AUTH_FILE" ]]; then
    mv "$AUTH_FILE" "$AUTH_BACKUP"
    echo "Moved auth.json to backup"
fi

# Skip local LLM tests (ollama, lmstudio)
export PI_NO_LOCAL_LLM=1

# Unset API keys (see packages/ai/src/stream.ts getEnvApiKey)
unset ANTHROPIC_API_KEY
unset ANTHROPIC_OAUTH_TOKEN
unset OPENAI_API_KEY
unset AZURE_OPENAI_API_KEY
unset DEEPSEEK_API_KEY
unset GEMINI_API_KEY
unset GOOGLE_CLOUD_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset ZAI_API_KEY
unset MISTRAL_API_KEY
unset MINIMAX_API_KEY
unset MINIMAX_CN_API_KEY
unset MOONSHOT_API_KEY
unset KIMI_API_KEY
unset HF_TOKEN
unset FIREWORKS_API_KEY
unset TOGETHER_API_KEY
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset CLOUDFLARE_API_KEY
unset CLOUDFLARE_ACCOUNT_ID
unset CLOUDFLARE_GATEWAY_ID
unset XIAOMI_API_KEY
unset XIAOMI_TOKEN_PLAN_CN_API_KEY
unset XIAOMI_TOKEN_PLAN_AMS_API_KEY
unset XIAOMI_TOKEN_PLAN_SGP_API_KEY
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
unset GOOGLE_APPLICATION_CREDENTIALS
unset GOOGLE_CLOUD_PROJECT
unset GCLOUD_PROJECT
unset GOOGLE_CLOUD_LOCATION
unset AWS_PROFILE
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
unset AWS_REGION
unset AWS_DEFAULT_REGION
unset AWS_BEARER_TOKEN_BEDROCK
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
unset AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_WEB_IDENTITY_TOKEN_FILE
unset BEDROCK_EXTENSIVE_MODEL_TEST

# 存储根隔离。测试早就把 cwd 隔离到 /tmp/pi-runtime-*，但**存储根没隔离**——
# SessionManager 的存储根来自 getAgentDir()，也就是真实 $HOME/.pie，再按 cwd 哈希分目录。
# 后果：跑一次测试，真实 ~/.pie/sessions 就多出十几个会话文件（曾累积到三千多个）。
#
# 只隔离 PIE_DIR，**绝不覆盖 HOME**：上面那段 auth.json 备份/恢复逻辑依赖真实 HOME，
# 而且 oracle 的 base_dir() 本身就是 `${PIE_DIR:-$HOME/.pie}`（config.rs:10-17），
# 隔离这一个变量就是 oracle 语义下的正确做法。
#
# auth.json 备份逻辑保留不动：它守的是「测试意外写坏真实凭据」，与会话目录泄漏是两件事，
# 而且 test.sh 的 unset 列表清掉 provider key 之后仍可能有别的路径碰到它。
export PIE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pie-test-home.XXXXXX")"

# 隔离的是**状态**（会话、设置、凭据），不是**工具依赖**。
# grep/find 工具从 `getBinDir()` = `$PIE_DIR/bin` 取 `rg`/`fd`；把 PIE_DIR 换成空目录之后
# 16 条工具测试会因为找不到二进制而红——那不是密闭性问题，是把洗澡水和孩子一起倒了。
# 测试需要 `rg` 就像需要 `node` 一样，软链过去即可；真正要隔离的会话目录仍然是空的。
# 若开发者机器上没有这两个二进制，这里什么也不做，那些测试照旧红——与隔离前的行为一致。
mkdir -p "$PIE_DIR/bin"
for _tool in fd rg; do
    if [[ -e "$HOME/.pie/bin/$_tool" ]]; then
        ln -sf "$HOME/.pie/bin/$_tool" "$PIE_DIR/bin/$_tool"
    fi
done

echo "Running tests without API keys..."
npm run test:raw
