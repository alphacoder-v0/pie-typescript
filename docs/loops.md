# Loops: stateful cron jobs + the triage inbox

> "Stop prompting the agent. Build loops that prompt the agent for you."

`pie` already had the heartbeat: cron jobs and triggers can run a prompt on a schedule or when
something happens. But a plain cron job is an amnesiac — every run starts from a fresh context, so
"tell me what changed since yesterday" was impossible, because there was no yesterday. And whatever
the job found either interrupted your chat or sank into the audit log.

Loops fix both halves:

1. **Stateful cron jobs** give a recurring job a memory file — a small notebook the agent writes at
   the end of each run and reads back at the start of the next.
2. **The triage inbox** gives findings a place to land that is *not* your conversation. You review
   them when convenient, like email, and promote the ones that matter into a real agent turn with
   one command.

## Quick start

```text
/cron add --stateful "0 9 * * *" check the GitHub issues of this repo and report anything new or newly closed since the last run
```

That's the whole setup for the `/cron add` path — typing `/cron add` is an explicit user action, so
the job is enabled immediately. Every morning at 09:00:

- the job runs in a **sub-agent with a fresh context** — your main conversation is never
  interrupted;
- the prompt is automatically prefixed with the agent's own notes from the previous run
  (`(first run)` the first time);
- the agent does the work, then ends its reply with two kinds of structured tags:
  - `<loop-state>…</loop-state>` — its notes for tomorrow's run (replaces the saved state);
  - `<inbox>one concise line</inbox>` — one tag per thing a human should act on.
- `pie` extracts the tags: state goes to the job's state file, findings go to the inbox. A run with
  no `<inbox>` tags is a quiet run — your inbox stays clean.

Then, whenever you sit down:

```text
/inbox                 # list new findings
/inbox claim 1         # feed finding #1 into the main chat as a real agent turn
/inbox dismiss 2       # not interesting
/inbox clear           # dismiss everything new
/inbox all             # include claimed/dismissed history
```

`/inbox claim` is the payoff: it converts a finding into a normal prompt in your main session — the
agent is asked to investigate and address the finding, named with the loop it came from — with the
same streaming, abort and approval semantics as anything you type yourself.

The TUI panel and the web UI show a live `Inbox  N new` indicator, so you notice findings without
polling.

## Behaviour that differs from Rust pie

This page describes the TypeScript port. Three things here are not what the Rust original's
documentation says.

### A loop the model creates starts disabled

If you ask for a loop in chat ("every hour, check … and keep notes between runs"), the model calls
the `NewCronJob` tool with `stateful: true`. **In this port that job is created disabled**, and
nothing runs until you enable it:

```text
/cron list                 # find the id
/cron enable cron-abc12345
```

Rust pie put a model-created job live on the very next tick with no human in the loop, while
simultaneously refusing a model-driven *re-*enable and demanding `/cron enable`. Two tools, one
capability, opposite rules. This port applies the strict rule to both: a model can create a job,
only a person can bring it into effect. Full argument in
`migration/parity/intentional-divergences.md` (D4).

The tool description the model reads says so too, so a well-behaved model will report the job as
needing enabling rather than as scheduled.

### `/cron remove` does not delete the loop state file

Rust pie's documentation claims `/cron remove <id>` deletes the job **and its state file**. The Rust
code never deleted the state file, and this port reproduces that faithfully (ledger row B7). Removing
a loop leaves an orphan `…loop-cron-<8 hex>.md` next to the session transcript. It is inert —
nothing reads it once the job is gone — but you may want to delete it yourself.

### Loops are not serialized against your chat

Regular (non-stateful) cron jobs use the inject-and-run path: when due, they enter the same
serialized agent turn slot as your own prompts, so exactly one turn is in flight at a time and the
result lands in your conversation.

**Stateful jobs do not.** They run as detached sub-agents, which is precisely what keeps them out of
your chat — and it also means two loops that come due in the same minute can run at the same time.
Rust pie's README describes all cron jobs as entering "the same serialized agent turn queue"; that
sentence is true of the inject-and-run path and false of the sub-agent path.

Per-job overlap protection still applies in both cases: if a job is still running when its own next
tick arrives, that tick is skipped and counted in `skipped_overlap_count` on the job's status.
Missed ticks after downtime are never backfilled.

## The design idea

**The state spine.** A loop is only a loop if run *N+1* knows what run *N* saw. Before this, people
hand-pasted "baseline" blobs into their cron prompts, and the blobs rotted immediately. Now the
agent maintains its own baseline, in its own words, in a file it rewrites every run. The contract is
deliberately humble: it's a scratchpad capped at 2000 characters, not a database. If you need real
state, the agent can keep files or call tools — the spine is just enough memory to know what "new"
means.

**The routing layer.** Automation output needs a destination that is neither "interrupt the human
now" nor "write-only log." The inbox is that third place. It's a global JSONL file
(`~/.pie/inbox.jsonl`) shared across all sessions and projects — the inbox is what you open in the
morning, wherever the loops ran. Findings are one-liners, capped and bounded, with a
`new → claimed/dismissed` lifecycle. Triage is a human act; acting on a finding is an agent act; the
inbox is the boundary between them.

A few deliberate choices fall out of this:

- **Stateful jobs never touch the main chat.** Loops are background creatures; the inbox is their
  only voice.
- **The protocol is plain text, not an API.** The output contract is injected into the job prompt as
  instructions, and the tags are parsed from the sub-agent's final reply. Any model that can follow
  instructions can run a loop — nothing provider-specific.
- **Tag extraction never fails a run.** Malformed or missing tags mean: state file untouched, nothing
  enters the inbox, run still completes. A truncated tag is ignored. Corrupt inbox lines are skipped
  on read, never deleted.
- **Everything is bounded.** State is capped at 2000 characters (truncated with a `…` marker on both
  read and write), inbox entries at 500 characters, at most 16 findings honoured per run. A runaway
  loop can't flood your disk or your attention.

## Reference

### Creating loops

| Surface | How |
|---------|-----|
| Slash command | `/cron add --stateful "<minute hour dom month dow>" <prompt>` — enabled immediately |
| Natural language | ask in chat; the `NewCronJob` tool has a `stateful` flag the model sets — **created disabled**, run `/cron enable <id>` |
| Inspect | `/cron list` shows a `[stateful]` marker on loop jobs |
| Remove | `/cron remove <id>` deletes the job; the state file is **left behind** (see above) |

### The injected prompt shape

What the sub-agent actually receives each run:

```text
[loop-state] (your notes from the previous run of this recurring job)
<contents of the state file, or "(first run)">
[/loop-state]

<your job prompt>

Output protocol (mandatory):
- End your reply with <loop-state>notes for the next run</loop-state> — it REPLACES the saved state; keep it under 2000 characters and make it the information your next run needs (baselines, ids already seen, watermarks).
- For each finding a human should act on, emit <inbox>one concise line</inbox>. No findings → no inbox tags; do not invent work.
- Keep everything after the last tool call short so the tags are not truncated.
```

### Inbox commands

| Command | What it does |
|---------|--------------|
| `/inbox` | List new findings with numbers |
| `/inbox all` | Include claimed and dismissed entries |
| `/inbox claim <n\|inb-id>` | Mark claimed and start a main-chat turn on the finding |
| `/inbox dismiss <n\|inb-id>` | Mark dismissed |
| `/inbox clear` | Dismiss all new entries |

### Storage

| Path | What |
|------|------|
| `~/.pie/sessions/<cwd-hash>/<session>.cron.toml` | The job itself (session-scoped, restored by `--resume`) |
| `~/.pie/sessions/<cwd-hash>/<session>.loop-cron-<8 hex>.md` | The job's loop state (plain Markdown — you can read or edit it) |
| `~/.pie/inbox.jsonl` | The global inbox (append-friendly JSONL, status rewrites are serialized) |

The loop state filename uses the first 8 hex characters of the job id after the `cron-` marker.

Loop state is session-scoped like the job that owns it, and is human-readable on purpose: `cat` it
to see what your loop "remembers," or edit it to correct the agent's notes.

### Not yet built

Both of these were listed as future work by Rust pie and remain unbuilt here — verified in this
port, not assumed:

- **Loop state is not bundled into `/session export` archives.** The archive carries the transcript
  plus the trigger and cron sidecars; the `loop-*.md` files are not included.
- **The web UI shows the inbox count only.** There are no claim/dismiss buttons in the browser;
  triage happens through `/inbox`.

Rust pie also listed an optional maker/checker verification pass (a second sub-agent adversarially
reviewing findings before they enter the inbox). It does not exist on either side.
