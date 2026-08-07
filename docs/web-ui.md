# The browser UI

`pie` ships two front-ends over the same session: a full-screen terminal UI and a local browser UI.
The browser UI is not a reduced chat-only surface — it is an alternative to the TUI, driving the
same agent, the same session file and the same slash-command registry.

## Which one you get

The selection rule is inherited from Rust pie and catches people out, because the default is the
opposite of what most CLI tools do:

| Situation | UI |
|---|---|
| `--web` passed | Browser UI |
| `--tui` passed | Terminal UI |
| stdin **or** stdout is not a TTY | Headless (line-based) — pipes, CI, `echo … \| pie` |
| Interactive TTY, remote session | Terminal UI |
| Interactive TTY, local session | **Browser UI** |

"Remote" means any of `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY` or `MOSH_CONNECTION` is *present* in
the environment — presence, not non-emptiness, so `SSH_TTY=` (set but empty) still counts as remote.

So: on your own laptop, plain `pie` opens a browser. Over ssh, plain `pie` stays in the terminal.
`--tui` overrides the first case.

## Starting it

```bash
./pie --web
./pie --web --web-port 8123
```

`pie` prints the bound address and then tries to open your default browser:

```text
pie web listening on http://127.0.0.1:41234
```

Browser auto-open failures are reported and ignored — the server keeps running, so you can open the
printed URL yourself.

Defaults: `--web-host 127.0.0.1`, `--web-port 0` (bind a random free port).

## Security model: loopback only

There is no authentication, and that is deliberate — the entire security story is that the socket is
not reachable from anywhere else.

`pie` **refuses to bind a non-loopback address.** A non-loopback `--web-host` is a hard error at
startup, not a warning:

```text
refusing non-loopback web bind 0.0.0.0; Web UI is loopback-only
```

Loopback means `127.0.0.0/8` for IPv4 and `::1` for IPv6, matching the Rust original exactly. If you
want remote access, do not defeat this check — forward the port over ssh, or use `/web-connect` (see
below).

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | The single-page app (a self-contained HTML file served from the build) |
| `GET` | `/state` | Current snapshot |
| `GET` | `/events` | Server-sent event stream of incremental snapshots |
| `POST` | `/prompt` | Submit a prompt |
| `POST` | `/model` | Switch model |
| `POST` | `/complete` | Slash-command / mention completion |
| `POST` | `/abort` | Abort the running turn |
| `POST` | `/trigger/immediate` | Run a trigger now |
| `POST` | `/control-plane/resolve` | Answer an approval prompt |

Snapshots are bounded and incremental rather than repeated full transcripts. API keys, auth-store
values, base64 image data and raw oversized tool payloads are kept out of the event stream.

## What is in the browser

- The conversation feed: assistant text, thinking deltas, tool calls, tool progress, tool results,
  turn errors and turn completion.
- Slash commands, dispatched through the *same* registry as the terminal UI — the browser is not a
  reduced command set.
- Model switching, with a credential check.
- The automation panel, including a live `inbox_new` count from stateful loops.
- Approval prompts, resolved through `/control-plane/resolve`.

Text selection works the way it does in any web page, which is one of the reasons the browser UI
exists at all.

### Known limits

- **The inbox is read-only in the browser.** You see the count; there are no claim/dismiss buttons.
  Triage happens through the `/inbox` slash command. See [loops.md](loops.md).
- **No authentication and no non-loopback mode.** Both are intentional and neither is planned here
  without a separate threat model.

## Not the same thing as `/web-connect`

`--web` is a local server on your own machine. The separate `/web-connect` slash command mounts the
running session at a public relay so it can be watched and prompted through a secret URL, and
`/web-disconnect` tears that down and invalidates the URL. That is a different feature with a
different trust boundary; it is not covered by this page.
