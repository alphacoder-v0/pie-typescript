# pie + DS4: KV prefix-cache optimizations for local models

`pie` was originally built to drive long-running automation on a local
[DS4](https://github.com/antirez/ds4) (DeepSeek V4 Flash) server, so the ds4 integration gets
first-class attention. This page covers the client-side optimizations that make `pie`'s request
stream *cache-exact* for DS4's KV prefix cache — and what that buys you in practice. All three
carried over into the TypeScript port and are covered by the differential scenarios `S5` (reasoning
replay) and `S4` (409 retry).

## Setting up a local model

Add a descriptor to `~/.pie/models.json` (user-global) or `<project>/.pie/models.json`
(project-local), then select it with `--provider` and `--model`:

```json
{
  "models": [
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash (local DS4)",
      "api": "openai-responses",
      "provider": "ds4",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null,
        "minimal": "low",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh"
      },
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 100000,
      "maxTokens": 384000,
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true,
        "supportsUsageInStreaming": true,
        "maxTokensField": "max_tokens",
        "supportsStrictMode": false,
        "thinkingFormat": "deepseek",
        "requiresReasoningContentOnAssistantMessages": true
      }
    }
  ]
}
```

`id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`, `cost`, `contextWindow` and `maxTokens` are
required; `thinkingLevelMap`, `input`, `headers` and `compat` are optional.

> **A project-local `models.json` is gated in this port.** `<cwd>/.pie/models.json` is not read
> unless the directory is trusted — a single `baseUrl` from an untrusted repository would silently
> point every prompt, file excerpt and tool result at someone else's endpoint. Run
> `pie --trust-project` in the directory, or set `PIE_TRUST_PROJECT=1`. See
> [project-trust.md](project-trust.md). `~/.pie/models.json` is never gated.

Then run:

```bash
export DS4_API_KEY=dsv4-local
./pie --provider ds4 --model deepseek-v4-flash --base-url http://127.0.0.1:8000/v1
```

DS4 is local and accepts placeholder bearer tokens. You can also store the same local placeholder
with `/login ds4`. Using the `ds4` provider keeps local model credentials separate from real
`OPENAI_API_KEY` credentials.

You can skip `models.json` entirely: `--base-url`, `DS4_BASE_URL` or `DS4_URL` (first non-blank
wins, in that order) registers exactly the descriptor above under `ds4` / `deepseek-v4-flash`. Keep
`models.json` when you need different limits, compatibility flags, or a project-local override.

Note that `--base-url` requires an explicit `--provider`: without one, `pie` would auto-detect a
provider from whatever credential happens to be in your environment and then aim it at the
overridden endpoint, so it refuses instead.

## Why this matters: byte-exact prefix caching

Hosted providers (Anthropic, OpenAI) do server-side prompt caching with explicit cache control and
fuzzy bookkeeping. A local DS4 server is stricter and simpler: it renders the request history into a
token stream and reuses KV checkpoints **only when the new request's rendered prefix is
byte-identical to what it sampled last time**. It can also persist those checkpoints to disk, so a
cache hit survives eviction and even a server restart.

The flip side: *any* divergence between what the model produced and what the client replays — a
dropped reasoning block, a reordered item — silently invalidates the prefix from that point on. On a
100k-token agent session that's the difference between re-prefilling a few hundred new tokens per
turn and re-prefilling the whole conversation every turn. On local hardware, prefill is the
bottleneck; this is the single biggest lever on perceived latency.

`pie`'s job as a client is therefore: **replay history exactly, retry the way the server expects,
and report cache traffic honestly.** That's the three fixes below.

## The three fixes

### 1. Replay assistant thinking as `reasoning` input items

DeepSeek V4 is a reasoning model: each assistant turn starts with thinking content. DS4 renders that
thinking into the sampled token stream, so it is part of the KV checkpoint. But the standard OpenAI
Responses client behaviour is to *drop* thinking when replaying history — which means the rendered
prefix `pie` sent back never matched what the server had sampled, and disk KV checkpoints went stale
the moment the live continuation state was evicted.

When a model descriptor sets `"requiresReasoningContentOnAssistantMessages": true`, `pie` replays
each assistant turn's thinking as a `{"type":"reasoning"}` input item, emitted **before** the
assistant message it belongs to (DS4 merges a reasoning item into the *following* message — ordering
is load-bearing).

With this, the rendered history is byte-identical across turns and DS4's checkpoints stay valid
across eviction and server restarts.

In this port the flag is read in `packages/ai/src/providers/openai-responses.ts` (and its Azure
sibling), which pass it through as `replayReasoningContent` to the shared Responses encoder.

### 2. Treat HTTP 409 as retryable

When DS4 has lost the live continuation state for a session (evicted, restarted), it answers
`409 Conflict`, meaning: *"replay the full history and I'll rebuild from my disk checkpoints."*
`pie` always sends the full history anyway — so for `pie`, a plain retry of the same request **is**
the replay the server is asking for.

The retry layer (`packages/ai/src/utils/retry.ts`) includes 409 in its retryable status set,
alongside 408/425/429/5xx, with the usual backoff. What would otherwise surface as a hard error
mid-session heals transparently in one round trip.

This whole retry utility is a pie addition — the pi skeleton had no retry at the provider layer at
all.

### 3. Report cache writes in `/cost`

DS4 reports a non-standard usage field, `input_tokens_details.cache_write_tokens` — tokens newly
written into the prompt cache by this request. `pie` folds it into the usage record's `cacheWrite`,
so `/cost` shows both sides of the cache ledger (reads *and* writes) instead of crediting reads
only.

This is also your verification tool: on a healthy session you should see a large `cache read` count
and a small `cache write` count each turn. If cache reads collapse to zero mid-session, the prefix
diverged — which, after fix #1, should no longer happen.

**Two things about `/cost` changed in the TypeScript port.** Both are declared divergences from Rust
pie, written up in `migration/parity/intentional-divergences.md`:

- **Token totals no longer double-count the cache.** Rust pie kept the provider's raw `input_tokens`
  (which already includes cached tokens) and then *added* the cache buckets on top. 100 input / 80
  cache-read / 20 cache-write / 10 output was reported as `total = 210`; the correct total is 110.
  If you compare a `/cost` reading against an older Rust pie session, expect the totals to be lower
  here — and correct. (Divergence D1.)
- **Dollar figures are real.** Rust pie never priced usage at all, so every amount was `$0.00`. This
  port prices against the model catalog. For a local DS4 descriptor whose `cost` block is all zeros
  this still displays `$0.00` — correctly, because a local model *is* free — so use the token
  counts, not the dollars, to verify cache behaviour. (Divergence D2.)

## Verifying on your setup

Start DS4 with disk-backed KV so checkpoints survive restarts. Those flags belong to the DS4 server,
not to `pie` — check the DS4 project for the current spelling. Then:

```bash
export DS4_API_KEY=dsv4-local
./pie --provider ds4 --model deepseek-v4-flash --base-url http://127.0.0.1:8000/v1
```

Then, inside `pie`:

1. Run a few turns, then `/cost` — `cache read` should dominate `input` from the second turn on.
2. Restart the DS4 server mid-session and send another prompt — the turn should succeed (one
   transparent 409 retry) and cache reads should resume from the disk checkpoints rather than
   starting over.

## Scope

These changes live in the `openai-responses` provider and the shared retry utility, all gated so
other backends are unaffected:

- reasoning replay only activates when the model descriptor sets
  `requiresReasoningContentOnAssistantMessages` (the ds4 descriptor does);
- `cache_write_tokens` is read only if the server sends it;
- 409-retry is generic, and correct for any API where the client always sends full history (`pie`'s
  only mode).

If you run a different local server that does byte-exact prefix caching and consumes reasoning input
items, setting the same compat flag in your `models.json` entry gets you the same behaviour —
nothing here is hard-coded to ds4.
