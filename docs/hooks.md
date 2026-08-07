# CLI Hooks

> ## Status in this port: ported, tested, **not wired**
>
> `packages/coding-agent/src/hooks.ts` is a complete translation of the Rust hook runner — config
> parsing, the project-hook opt-in gate, event vocabulary, command and webhook execution, timeouts,
> redaction, the whole thing — and it has its own test file. **But nothing in the CLI imports it.**
> No `~/.pie/hooks.toml` is read and no hook fires today.
>
> This page documents the format so it stays accurate for the day the wiring lands, and so you can
> write a `hooks.toml` that will work then. Do not expect hooks to run now. Tracked in
> `migration/post-parity-backlog.md`; the startup diagnostics agree — the `cli_hooks` hook point is
> always reported as absent.
>
> Everything below has been checked against `src/hooks.ts` in this repository, not copied from the
> Rust documentation.

`pie` can run user-configured hooks when agent lifecycle events fire. Hooks are best-effort side
effects: they can run shell commands or POST JSON to webhooks, but they do not mutate agent state
and failures do not fail the agent turn.

## Configuration

User hooks live at:

```text
~/.pie/hooks.toml
```

Project hooks can live at:

```text
<repo>/.pie/hooks.toml
```

Project hooks are ignored by default because they can execute commands from a cloned repository.
Enable them explicitly from your user config:

```toml
allow_project_hooks = true
```

or for one process:

```sh
PIE_ALLOW_PROJECT_HOOKS=1 pie
```

(`PIE_ALLOW_PROJECT_HOOKS` accepts `1` or a case-insensitive `true`.) A project `hooks.toml` that
exists but is not allowed contributes no rules and produces a diagnostic naming both ways to allow
it.

This gate is inherited unchanged from Rust pie and is **separate** from the newer project trust
store — hooks predate it and keep their own switch. See [project-trust.md](project-trust.md) for the
gate that covers `mcp.toml`, `lsp.toml` and `models.json`.

## Examples

Append every finished tool call to a log:

```toml
[[hook]]
event = "tool_end"
command = "echo \"$PIE_TOOL_NAME error=$PIE_TOOL_IS_ERROR\" >> ~/.pie/tool-hooks.log"
timeout_ms = 3000
```

Run only when the `bash` tool finishes:

```toml
[[hook]]
event = "tool_end"
tool = "bash"
command = "echo \"bash finished in $PIE_SESSION_ID\" >> ~/.pie/bash-hooks.log"
```

Send a webhook when a turn ends:

```toml
[[hook]]
event = "turn_end"
webhook = "https://example.com/pie/hooks"
timeout_ms = 5000

[hook.headers]
Authorization = "Bearer your-token"
```

Send a desktop notification on macOS when the agent finishes a response:

```toml
[[hook]]
event = "agent_end"
command = "osascript -e 'display notification \"pie finished\" with title \"pie\"'"
```

Send a webhook when context compaction runs:

```toml
[[hook]]
event = "compaction"
webhook = "https://example.com/pie/compaction"
timeout_ms = 5000
```

## Hook fields

Each `[[hook]]` supports:

```toml
event = "tool_end"       # required
command = "..."          # optional shell command
webhook = "https://..."  # optional HTTP POST endpoint
timeout_ms = 5000        # optional, default 5000
enabled = true           # optional, default true
cwd = "project"          # project | pie | home, default project
on_failure = "warn"      # warn | ignore, default warn
tool = "bash"            # optional filter for tool_* events
```

`command` and `webhook` can be used together; the command runs first, then the webhook is sent. A
hook with neither is rejected with a diagnostic. Unknown keys are tolerated, matching the Rust
parser.

## Events

Supported events:

```text
agent_start
agent_end
turn_start
turn_end
message_start
message_update
message_end
tool_start
tool_update
tool_end
compaction
```

`message_update` can fire frequently while a model streams. Use it only when you actually need
streaming-level callbacks.

`compaction` fires after successful automatic context compaction and after manual `/compact`. Its
payload includes `compaction_trigger = "auto" | "manual"`, the estimated summarized token count, and
a truncated summary. Compaction summaries can contain sensitive context; only send them to
destinations you trust.

## Command environment

Command hooks always receive:

```text
PIE_HOOK_EVENT
PIE_HOOK_PAYLOAD
PIE_SESSION_ID
PIE_CWD
PIE_MODEL_PROVIDER
PIE_MODEL_ID
PIE_THINKING_LEVEL
```

and, when the corresponding payload field is non-null for this event:

```text
PIE_MESSAGE_KIND
PIE_ASSISTANT_EVENT
PIE_TOOL_CALL_ID
PIE_TOOL_NAME
PIE_TOOL_IS_ERROR
PIE_COMPACTION_TRIGGER
PIE_COMPACTION_TOKENS_BEFORE
```

`PIE_HOOK_PAYLOAD` points to a temporary JSON file containing the same payload sent to webhooks.
Message summaries, tool arguments, tool result summaries and compaction summaries are available in
that JSON payload only — they are not exported as environment variables.

## Webhook payload

Webhook hooks receive `Content-Type: application/json`. Every optional field is present as an
explicit `null` rather than omitted:

```json
{
  "event": "tool_end",
  "session_id": "...",
  "cwd": "/path/to/repo",
  "model_provider": "openai",
  "model_id": "gpt-5.5",
  "thinking_level": "off",
  "source": "user",
  "message_kind": null,
  "message_summary": null,
  "assistant_event": null,
  "tool_call_id": "call_...",
  "tool_name": "bash",
  "tool_is_error": false,
  "tool_args": { "command": "..." },
  "tool_result_summary": "...",
  "compaction_trigger": null,
  "compaction_tokens_before": null,
  "compaction_summary": null
}
```

Long message and tool summaries are truncated before being placed in the payload.

A compaction event fills the last three fields instead:

```json
{
  "event": "compaction",
  "session_id": "...",
  "cwd": "/path/to/repo",
  "model_provider": "openai",
  "model_id": "gpt-5.5",
  "thinking_level": "off",
  "source": "user",
  "compaction_trigger": "auto",
  "compaction_tokens_before": 12345,
  "compaction_summary": "..."
}
```

Long compaction summaries are truncated before being placed in the payload.
