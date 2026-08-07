import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { renderCliHelp, shouldPrintDynamicTopLevelHelp } from "../src/cli/help.ts";

describe("parseArgs", () => {
	describe("--version flag", () => {
		test("parses --version flag", () => {
			const result = parseArgs(["--version"]);
			expect(result.version).toBe(true);
		});

		test("parses -v shorthand", () => {
			const result = parseArgs(["-v"]);
			expect(result.version).toBe(true);
		});

		test("--version takes precedence over other args", () => {
			const result = parseArgs(["--version", "--help", "some message"]);
			expect(result.version).toBe(true);
			expect(result.help).toBe(true);
			expect(result.messages).toContain("some message");
		});
	});

	describe("--help flag", () => {
		test("parses --help flag", () => {
			const result = parseArgs(["--help"]);
			expect(result.help).toBe(true);
		});

		test("parses -h shorthand", () => {
			const result = parseArgs(["-h"]);
			expect(result.help).toBe(true);
		});
	});

	describe("--print flag", () => {
		test("parses --print flag", () => {
			const result = parseArgs(["--print"]);
			expect(result.print).toBe(true);
		});

		test("parses -p shorthand", () => {
			const result = parseArgs(["-p"]);
			expect(result.print).toBe(true);
		});

		test("parses prompt after -p even when it starts with YAML frontmatter", () => {
			const prompt = "---\ntitle: hello\n---\nSay hi.";
			const result = parseArgs(["-p", prompt]);
			expect(result.print).toBe(true);
			expect(result.messages).toEqual([prompt]);
			expect(result.unknownFlags.size).toBe(0);
		});

		test("does not consume options after -p as prompts", () => {
			const result = parseArgs(["-p", "--provider", "openai", "Say hi."]);
			expect(result.print).toBe(true);
			expect(result.provider).toBe("openai");
			expect(result.messages).toEqual(["Say hi."]);
		});
	});

	describe("--continue flag", () => {
		test("parses --continue flag", () => {
			const result = parseArgs(["--continue"]);
			expect(result.continue).toBe(true);
		});

		test("parses -c shorthand", () => {
			const result = parseArgs(["-c"]);
			expect(result.continue).toBe(true);
		});
	});

	describe("--resume flag", () => {
		test("parses --resume flag", () => {
			const result = parseArgs(["--resume"]);
			expect(result.resume).toBe(true);
		});

		test("parses -r shorthand", () => {
			const result = parseArgs(["-r"]);
			expect(result.resume).toBe(true);
		});
	});

	describe("flags with values", () => {
		test("parses --provider", () => {
			const result = parseArgs(["--provider", "openai"]);
			expect(result.provider).toBe("openai");
		});

		test("parses --model", () => {
			const result = parseArgs(["--model", "gpt-4o"]);
			expect(result.model).toBe("gpt-4o");
		});

		test("parses --api-key", () => {
			const result = parseArgs(["--api-key", "sk-test-key"]);
			expect(result.apiKey).toBe("sk-test-key");
		});

		test("parses --system-prompt", () => {
			const result = parseArgs(["--system-prompt", "You are a helpful assistant"]);
			expect(result.systemPrompt).toBe("You are a helpful assistant");
		});

		test("parses --append-system-prompt", () => {
			const result = parseArgs(["--append-system-prompt", "Additional context"]);
			expect(result.appendSystemPrompt).toEqual(["Additional context"]);
		});

		test("parses multiple --append-system-prompt flags", () => {
			const result = parseArgs(["--append-system-prompt", "Context A", "--append-system-prompt", "Context B"]);
			expect(result.appendSystemPrompt).toEqual(["Context A", "Context B"]);
		});

		test("parses --mode", () => {
			const result = parseArgs(["--mode", "json"]);
			expect(result.mode).toBe("json");
		});

		test("parses --mode rpc", () => {
			const result = parseArgs(["--mode", "rpc"]);
			expect(result.mode).toBe("rpc");
		});

		test("parses --session", () => {
			const result = parseArgs(["--session", "/path/to/session.jsonl"]);
			expect(result.session).toBe("/path/to/session.jsonl");
		});

		test("parses --fork", () => {
			const result = parseArgs(["--fork", "1234abcd"]);
			expect(result.fork).toBe("1234abcd");
			expect(result.messages).toEqual([]);
		});

		test("parses --export", () => {
			const result = parseArgs(["--export", "session.jsonl"]);
			expect(result.export).toBe("session.jsonl");
		});

		test("parses --thinking", () => {
			const result = parseArgs(["--thinking", "high"]);
			expect(result.thinking).toBe("high");
		});

		test("parses --models as comma-separated list", () => {
			const result = parseArgs(["--models", "gpt-4o,claude-sonnet,gemini-pro"]);
			expect(result.models).toEqual(["gpt-4o", "claude-sonnet", "gemini-pro"]);
		});
	});

	describe("--no-session flag", () => {
		test("parses --no-session flag", () => {
			const result = parseArgs(["--no-session"]);
			expect(result.noSession).toBe(true);
		});
	});

	describe("--extension flag", () => {
		test("parses single --extension", () => {
			const result = parseArgs(["--extension", "./my-extension.ts"]);
			expect(result.extensions).toEqual(["./my-extension.ts"]);
		});

		test("parses -e shorthand", () => {
			const result = parseArgs(["-e", "./my-extension.ts"]);
			expect(result.extensions).toEqual(["./my-extension.ts"]);
		});

		test("parses multiple --extension flags", () => {
			const result = parseArgs(["--extension", "./ext1.ts", "-e", "./ext2.ts"]);
			expect(result.extensions).toEqual(["./ext1.ts", "./ext2.ts"]);
		});
	});

	describe("--no-extensions flag", () => {
		test("parses --no-extensions flag", () => {
			const result = parseArgs(["--no-extensions"]);
			expect(result.noExtensions).toBe(true);
		});

		test("parses --no-extensions with explicit -e flags", () => {
			const result = parseArgs(["--no-extensions", "-e", "foo.ts", "-e", "bar.ts"]);
			expect(result.noExtensions).toBe(true);
			expect(result.extensions).toEqual(["foo.ts", "bar.ts"]);
		});
	});

	describe("--skill flag", () => {
		test("parses single --skill", () => {
			const result = parseArgs(["--skill", "./skill-dir"]);
			expect(result.skills).toEqual(["./skill-dir"]);
		});

		test("parses multiple --skill flags", () => {
			const result = parseArgs(["--skill", "./skill-a", "--skill", "./skill-b"]);
			expect(result.skills).toEqual(["./skill-a", "./skill-b"]);
		});
	});

	describe("--prompt-template flag", () => {
		test("parses single --prompt-template", () => {
			const result = parseArgs(["--prompt-template", "./prompts"]);
			expect(result.promptTemplates).toEqual(["./prompts"]);
		});

		test("parses multiple --prompt-template flags", () => {
			const result = parseArgs(["--prompt-template", "./one", "--prompt-template", "./two"]);
			expect(result.promptTemplates).toEqual(["./one", "./two"]);
		});
	});

	describe("--theme flag", () => {
		test("parses single --theme", () => {
			const result = parseArgs(["--theme", "./theme.json"]);
			expect(result.themes).toEqual(["./theme.json"]);
		});

		test("parses multiple --theme flags", () => {
			const result = parseArgs(["--theme", "./dark.json", "--theme", "./light.json"]);
			expect(result.themes).toEqual(["./dark.json", "./light.json"]);
		});
	});

	describe("--no-skills flag", () => {
		test("parses --no-skills flag", () => {
			const result = parseArgs(["--no-skills"]);
			expect(result.noSkills).toBe(true);
		});
	});

	describe("--no-prompt-templates flag", () => {
		test("parses --no-prompt-templates flag", () => {
			const result = parseArgs(["--no-prompt-templates"]);
			expect(result.noPromptTemplates).toBe(true);
		});
	});

	describe("--no-themes flag", () => {
		test("parses --no-themes flag", () => {
			const result = parseArgs(["--no-themes"]);
			expect(result.noThemes).toBe(true);
		});
	});

	describe("--no-context-files flag", () => {
		test("parses --no-context-files flag", () => {
			const result = parseArgs(["--no-context-files"]);
			expect(result.noContextFiles).toBe(true);
		});

		test("parses -nc shorthand", () => {
			const result = parseArgs(["-nc"]);
			expect(result.noContextFiles).toBe(true);
		});
	});

	describe("--verbose flag", () => {
		test("parses --verbose flag", () => {
			const result = parseArgs(["--verbose"]);
			expect(result.verbose).toBe(true);
		});
	});

	describe("--offline flag", () => {
		test("parses --offline flag", () => {
			const result = parseArgs(["--offline"]);
			expect(result.offline).toBe(true);
		});
	});

	describe("tool flags", () => {
		test("parses --no-tools flag", () => {
			const result = parseArgs(["--no-tools"]);
			expect(result.noTools).toBe(true);
		});

		test("parses -nt shorthand", () => {
			const result = parseArgs(["-nt"]);
			expect(result.noTools).toBe(true);
		});

		test("parses --no-builtin-tools flag", () => {
			const result = parseArgs(["--no-builtin-tools"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses -nbt shorthand", () => {
			const result = parseArgs(["-nbt"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses --tools flag", () => {
			const result = parseArgs(["--tools", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses -t shorthand", () => {
			const result = parseArgs(["-t", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses --no-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-tools", "--tools", "read,bash"]);
			expect(result.noTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses --no-builtin-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-builtin-tools", "--tools", "read,bash"]);
			expect(result.noBuiltinTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});
	});

	describe("messages and file args", () => {
		test("parses plain text messages", () => {
			const result = parseArgs(["hello", "world"]);
			expect(result.messages).toEqual(["hello", "world"]);
		});

		test("parses @file arguments", () => {
			const result = parseArgs(["@README.md", "@src/main.ts"]);
			expect(result.fileArgs).toEqual(["README.md", "src/main.ts"]);
		});

		test("parses mixed messages and file args", () => {
			const result = parseArgs(["@file.txt", "explain this", "@image.png"]);
			expect(result.fileArgs).toEqual(["file.txt", "image.png"]);
			expect(result.messages).toEqual(["explain this"]);
		});

		test("captures unknown long flags with string values", () => {
			const result = parseArgs(["--unknown-flag", "message"]);
			expect(result.messages).toEqual([]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("message");
		});

		test("captures unknown boolean long flags", () => {
			const result = parseArgs(["--unknown-flag"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe(true);
		});

		test("captures unknown long flags with equals syntax", () => {
			const result = parseArgs(["--unknown-flag=value"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("value");
		});
	});

	describe("complex combinations", () => {
		test("parses multiple flags together", () => {
			const result = parseArgs([
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet",
				"--print",
				"--thinking",
				"high",
				"@prompt.md",
				"Do the task",
			]);
			expect(result.provider).toBe("anthropic");
			expect(result.model).toBe("claude-sonnet");
			expect(result.print).toBe(true);
			expect(result.thinking).toBe("high");
			expect(result.fileArgs).toEqual(["prompt.md"]);
			expect(result.messages).toEqual(["Do the task"]);
		});
	});

	// pie: main.rs:68-147 — the oracle-only half of the flag set.
	describe("oracle flags", () => {
		test("parses --base-url", () => {
			expect(parseArgs(["--base-url", "http://localhost:8080/v1"]).baseUrl).toBe("http://localhost:8080/v1");
		});

		test("bare --resume keeps the picker and sets no id", () => {
			const result = parseArgs(["--resume"]);
			expect(result.resume).toBe(true);
			expect(result.resumeId).toBeUndefined();
		});

		test("--resume <id> takes the id instead of opening the picker", () => {
			const result = parseArgs(["--resume", "019ea2fd"]);
			expect(result.resumeId).toBe("019ea2fd");
			expect(result.resume).toBeUndefined();
		});

		test("--resume does not swallow a following flag", () => {
			const result = parseArgs(["--resume", "--debug"]);
			expect(result.resume).toBe(true);
			expect(result.resumeId).toBeUndefined();
			expect(result.debug).toBe(true);
		});

		test("--resume-id wins over --resume <id>", () => {
			// pie: main.rs:209-212 (`effective_resume_id`).
			expect(parseArgs(["--resume", "aaaa", "--resume-id", "bbbb"]).resumeId).toBe("bbbb");
		});

		test("parses the session listing/deleting flags", () => {
			const result = parseArgs(["--list-sessions", "--list-all-sessions", "--delete-session", "019ea2fd"]);
			expect(result.listSessions).toBe(true);
			expect(result.listAllSessions).toBe(true);
			expect(result.deleteSession).toBe("019ea2fd");
		});

		test("--image and --builtin-skill are repeatable", () => {
			const result = parseArgs([
				"--image",
				"a.png",
				"--image",
				"b.png",
				"--builtin-skill",
				"x",
				"--builtin-skill",
				"y",
			]);
			expect(result.images).toEqual(["a.png", "b.png"]);
			expect(result.builtinSkills).toEqual(["x", "y"]);
		});

		test("parses --trigger-poll-secs and rejects values below the u64 range floor", () => {
			expect(parseArgs(["--trigger-poll-secs", "30"]).triggerPollSecs).toBe(30);
			for (const bad of ["0", "-1", "abc", "1.5"]) {
				const result = parseArgs(["--trigger-poll-secs", bad]);
				expect(result.triggerPollSecs).toBeUndefined();
				expect(result.usageError).toBeDefined();
			}
			// Flipped for phase 19 F9: this used to assert only "some diagnostic of type error", which
			// `main` printed as `Error: invalid value "0" for --trigger-poll-secs: must be an integer
			// >= 1` and exited **1**. Oracle's clap exits **2** and words it as its `u64` range parser
			// does. All three strings below are captured from the oracle binary.
			expect(parseArgs(["--trigger-poll-secs", "0"]).usageError).toBe(
				"error: invalid value '0' for '--trigger-poll-secs <SECONDS>': 0 is not in 1..18446744073709551615\n\n" +
					"For more information, try '--help'.\n",
			);
			expect(parseArgs(["--trigger-poll-secs", "abc"]).usageError).toBe(
				"error: invalid value 'abc' for '--trigger-poll-secs <SECONDS>': invalid digit found in string\n\n" +
					"For more information, try '--help'.\n",
			);
			// `-1` is not a value at all to clap — it looks like a flag, and no flag is spelled `-1`.
			expect(parseArgs(["--trigger-poll-secs", "-1"]).usageError).toBe(
				"error: unexpected argument '-1' found\n\nUsage: pie [OPTIONS] [COMMAND]\n\n" +
					"For more information, try '--help'.\n",
			);
		});

		test("parses the approval flags", () => {
			expect(parseArgs(["--yes"]).yes).toBe(true);
			expect(parseArgs(["--always-allow"]).alwaysAllow).toBe(true);
			expect(parseArgs(["--debug"]).debug).toBe(true);
		});

		test("parses the web transport flags", () => {
			const result = parseArgs(["--web", "--web-host", "127.0.0.1", "--web-port", "8123"]);
			expect(result.web).toBe(true);
			expect(result.webHost).toBe("127.0.0.1");
			expect(result.webPort).toBe(8123);
		});

		test("rejects a --web-port outside the u16 range", () => {
			const result = parseArgs(["--web-port", "70000"]);
			expect(result.webPort).toBeUndefined();
			// Flipped for phase 19 F9 (a site beyond the six the audit measured): the old assertion
			// accepted `Error: invalid value "70000" for --web-port: must be an integer in 0..=65535`
			// with exit 1. Oracle's clap says this and exits 2.
			expect(result.usageError).toBe(
				"error: invalid value '70000' for '--web-port <PORT>': 70000 is not in 0..=65535\n\n" +
					"For more information, try '--help'.\n",
			);
			expect(parseArgs(["--web-port", "abc"]).usageError).toBe(
				"error: invalid value 'abc' for '--web-port <PORT>': invalid digit found in string\n\n" +
					"For more information, try '--help'.\n",
			);
		});

		test("--web conflicts with --tui", () => {
			// pie: main.rs:137,140 `conflicts_with`.
			//
			// Flipped for phase 19 F9: the old assertion accepted a bare message with no `Usage:` block
			// (exit 1). clap adds one, and it names whichever of the pair it saw FIRST — measured on
			// the oracle binary, both orders.
			expect(parseArgs(["--web", "--tui"]).usageError).toBe(
				"error: the argument '--web' cannot be used with '--tui'\n\nUsage: pie --web\n\n" +
					"For more information, try '--help'.\n",
			);
			expect(parseArgs(["--tui", "--web"]).usageError).toBe(
				"error: the argument '--tui' cannot be used with '--web'\n\nUsage: pie --tui\n\n" +
					"For more information, try '--help'.\n",
			);
		});

		test("an invalid --thinking level is a usage error, not a warning", () => {
			// pie: main.rs:80-83 `value_parser = commands::THINKING_LEVEL_VALUES`. Phase 19 F12: this
			// side used to emit `Warning: Invalid thinking level "wobble". Valid values: …` and then
			// run on the default with exit 0, so the user believed thinking was on when it was off.
			expect(parseArgs(["--thinking", "wobble"]).usageError).toBe(
				"error: invalid value 'wobble' for '--thinking <THINKING>'\n" +
					"  [possible values: off, minimal, low, medium, high, xhigh]\n\n" +
					"For more information, try '--help'.\n",
			);
			expect(parseArgs(["--thinking", "wobble"]).thinking).toBeUndefined();
			// A valid level is untouched.
			expect(parseArgs(["--thinking", "xhigh"]).usageError).toBeUndefined();
			expect(parseArgs(["--thinking", "xhigh"]).thinking).toBe("xhigh");
		});

		test("an unknown short flag is clap's unexpected-argument page", () => {
			// Phase 19 F13: `Error: Unknown option: -z` named the failure and no next step.
			expect(parseArgs(["-z"]).usageError).toBe(
				"error: unexpected argument '-z' found\n\nUsage: pie [OPTIONS] [COMMAND]\n\n" +
					"For more information, try '--help'.\n",
			);
		});

		test("a value-taking oracle option with no value is clap's missing-value page", () => {
			// Phase 19 F9. Before: `--model` with nothing after it fell through to the extension-flag
			// bucket and resurfaced as `Error: Unknown option: --model` — a flag `--help` documents —
			// with exit 1. All four strings captured from the oracle binary.
			expect(parseArgs(["--model"]).usageError).toBe(
				"error: a value is required for '--model <MODEL>' but none was supplied\n\n" +
					"For more information, try '--help'.\n",
			);
			// A *known* flag following it is still a missing value, not a value…
			expect(parseArgs(["--model", "--tui"]).usageError).toBe(
				"error: a value is required for '--model <MODEL>' but none was supplied\n\n" +
					"For more information, try '--help'.\n",
			);
			// …while an unknown dash token is reported as the unexpected argument it is.
			expect(parseArgs(["--web-host", "-5"]).usageError).toBe(
				"error: unexpected argument '-5' found\n\nUsage: pie [OPTIONS] [COMMAND]\n\n" +
					"For more information, try '--help'.\n",
			);
			// clap appends the possible-values line to a missing value too.
			expect(parseArgs(["--thinking"]).usageError).toBe(
				"error: a value is required for '--thinking <THINKING>' but none was supplied\n" +
					"  [possible values: off, minimal, low, medium, high, xhigh]\n\n" +
					"For more information, try '--help'.\n",
			);
		});

		test("bare --resume and bare --print stay legal", () => {
			// `--resume` is `num_args = 0..=1` (it opens the picker) and `--print` is the skeleton's
			// own optional-value flag; neither can be a missing-value error.
			expect(parseArgs(["--resume"]).usageError).toBeUndefined();
			expect(parseArgs(["--resume"]).resume).toBe(true);
			expect(parseArgs(["--print"]).usageError).toBeUndefined();
			expect(parseArgs(["--print"]).print).toBe(true);
		});

		test("a skeleton-only option still takes a dash-leading value", () => {
			// Oracle has no `--system-prompt`, so clap's "the next token starts with `-`, therefore it
			// is not my value" rule has nothing to align to here, and `pie --system-prompt "-be terse"`
			// is a working pi invocation. It stays working; only a genuinely absent value fails.
			expect(parseArgs(["--system-prompt", "-be terse"]).systemPrompt).toBe("-be terse");
			expect(parseArgs(["--system-prompt", "-be terse"]).usageError).toBeUndefined();
			expect(parseArgs(["--system-prompt"]).usageError).toBe(
				"error: a value is required for '--system-prompt <SYSTEM_PROMPT>' but none was supplied\n\n" +
					"For more information, try '--help'.\n",
			);
		});

		test("only the first usage error is reported, as clap does", () => {
			expect(parseArgs(["--thinking", "wobble", "--web-port", "70000"]).usageError).toContain(
				"invalid value 'wobble'",
			);
		});

		test("none of the oracle flags leak into unknownFlags", () => {
			const result = parseArgs([
				"--base-url",
				"u",
				"--resume-id",
				"i",
				"--list-sessions",
				"--list-all-sessions",
				"--delete-session",
				"d",
				"--image",
				"p",
				"--builtin-skill",
				"s",
				"--trigger-poll-secs",
				"5",
				"--debug",
				"--yes",
				"--always-allow",
				"--tui",
				"--web-host",
				"h",
				"--web-port",
				"0",
			]);
			expect([...result.unknownFlags.keys()]).toEqual([]);
		});

		test("accepts clap's -V spelling of --version alongside the skeleton's -v", () => {
			expect(parseArgs(["-V"]).version).toBe(true);
			expect(parseArgs(["-v"]).version).toBe(true);
		});
	});
});

// pie: main.rs:391-422 + commands.rs:1264-1296. Byte-for-byte parity with the oracle page is
// verified end-to-end by the parity judge (migration/parity/scenarios/s1-help.sh); these cover the
// renderer's structural invariants so a layout regression fails fast and locally.
describe("renderCliHelp", () => {
	const help = renderCliHelp();
	const lines = help.split("\n");

	test("opens with oracle's about + usage block", () => {
		expect(lines.slice(0, 5)).toEqual([
			"Simple coding agent on top of pie-agent-core",
			"",
			"Usage: pie [OPTIONS] [COMMAND]",
			"",
			"Commands:",
		]);
	});

	test("lists every oracle option exactly once", () => {
		const expected = [
			"--provider <PROVIDER>",
			"--model <MODEL>",
			"--base-url <URL>",
			"--thinking <THINKING>",
			"--resume [<ID>]",
			"-c, --continue",
			"--resume-id <ID>",
			"--list-sessions",
			"--list-all-sessions",
			"--delete-session <ID>",
			"--image <PATH>",
			"--builtin-skill <NAME>",
			"--trigger-poll-secs <SECONDS>",
			"--debug",
			"--yes",
			"--always-allow",
			"--web",
			"--tui",
			"--web-host <HOST>",
			"--web-port <PORT>",
			"-h, --help",
			"-V, --version",
		];
		const optionsStart = lines.indexOf("Options:") + 1;
		const optionLines = lines.slice(optionsStart, lines.indexOf("", optionsStart));
		expect(optionLines.map((line) => line.trim().split(/ {2,}/)[0])).toEqual(expected);
	});

	test("aligns every option description on the same column", () => {
		const optionsStart = lines.indexOf("Options:") + 1;
		const optionLines = lines.slice(optionsStart, lines.indexOf("", optionsStart));
		// The label ends at the first non-space followed by clap's >=2-space gap; the description
		// starts right after that gap.
		const columns = new Set(optionLines.map((line) => line.match(/^.*?\S {2,}(?=\S)/)![0].length));
		expect(columns.size).toBe(1);
		// clap's widest label here is `      --trigger-poll-secs <SECONDS>` (35 chars) + 2.
		expect([...columns]).toEqual([37]);
	});

	test("renders clap's default and possible-value suffixes", () => {
		expect(help).toContain(
			"Thinking level (off | minimal | low | medium | high | xhigh) [default: off] [possible values: off, minimal, low, medium, high, xhigh]",
		);
		expect(help).toContain("Must be a loopback address [default: 127.0.0.1]");
		expect(help).toContain("use 0 to bind a random free port [default: 0]");
	});

	test("closes with the model catalog after-help block and a trailing blank line", () => {
		expect(help).toMatch(/\nModel catalog:\n {2}Supported providers \(\d+\), models \(\d+\): \S/);
		expect(help).toContain("  Full list: /help models or /model list [provider]");
		expect(help).toContain("  Custom models: ~/.pie/models.json and <cwd>/.pie/models.json");
		expect(help.endsWith("  Credentials: set provider env vars or run /login <provider>.\n\n")).toBe(true);
	});

	test("names the binary pie, not the skeleton's pi", () => {
		expect(help).not.toMatch(/\bpi\b/);
	});
});

describe("shouldPrintDynamicTopLevelHelp", () => {
	test("fires for --help and -h anywhere in the argument list", () => {
		expect(shouldPrintDynamicTopLevelHelp(["--help"])).toBe(true);
		expect(shouldPrintDynamicTopLevelHelp(["-h"])).toBe(true);
		expect(shouldPrintDynamicTopLevelHelp(["--provider", "openai", "--help"])).toBe(true);
	});

	test("does not fire without a help flag", () => {
		expect(shouldPrintDynamicTopLevelHelp([])).toBe(false);
		expect(shouldPrintDynamicTopLevelHelp(["--debug"])).toBe(false);
	});

	test("defers to clap when a declared subcommand is present", () => {
		expect(shouldPrintDynamicTopLevelHelp(["session", "--help"])).toBe(false);
		expect(shouldPrintDynamicTopLevelHelp(["session", "import", "--help"])).toBe(false);
	});

	test("still fires for `help --help`, which clap's unbuilt subcommand list does not cover", () => {
		// pie: main.rs:404-407 reads an unbuilt `Command`, so the auto-generated `help` subcommand
		// is absent from the list — matching the oracle binary, which prints the dynamic page here.
		expect(shouldPrintDynamicTopLevelHelp(["help", "--help"])).toBe(true);
	});
});
