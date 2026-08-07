/**
 * Port of oracle `crates/agent/src/harness/permission.rs` (pie @0a120dfd).
 *
 * Permission evaluator for tool calls.
 *
 * v1 scope (issue #4 part 1): a stateless classifier with two outcomes — Allow or Deny.
 * Dangerous bash patterns are short-circuited to Deny with a reason. A `Prompt` outcome is the
 * obvious follow-up; the oracle leaves the shape ready for it but ships without a UI for now, so
 * this module does the same (no `prompt` variant on `PermissionDecision` — matches the pi
 * skeleton's own `BeforeToolCallResult`, which has no `prompt` field either).
 *
 * Wire-up: callers build a `PermissionPolicy`, call `asBeforeToolCall()`, and assign the result
 * to `AgentOptions.beforeToolCall` (packages/agent/src/agent.ts) / `beforeToolCall` on
 * `BeforeToolCallContext` (packages/agent/src/types.ts) — the pi skeleton's existing hook point.
 *
 * Rule shape: most rules are simple substring regex (`sudo`, `curl|sh`, `mkfs`…). `rm` with
 * recursive + force flags in any permutation of short/long/separated forms lives as a
 * token-aware predicate — regex alone would either miss flag splits or accept a malformed shell
 * line and create false positives; this layer must close, not minimize.
 */

import type { AgentToolCall, BeforeToolCallContext, BeforeToolCallResult } from "../types.ts";

/** Outcome of evaluating a tool call. oracle permission.rs:29-32. Non-wire — idiomatic `type`-tagged union. */
export type PermissionDecision = { type: "allow" } | { type: "deny"; reason: string };

/**
 * Category of the operation being evaluated. oracle permission.rs:47-54. New categories should
 * be added sparingly — each adds a permission surface the user has to reason about.
 */
export type PermissionCategory = "tool" | "controlPlaneWrite";

/** One rule in the dangerous-bash corpus, token-aware (regex cannot cleanly express it). oracle permission.rs:59-62. */
interface PredicateRule {
	label: string;
	check: (cmd: string) => boolean;
}

/**
 * Permission evaluator. Bash tool calls are matched against a corpus of dangerous patterns;
 * everything else is allowed. oracle permission.rs:69-177 (`PermissionPolicy`).
 */
export class PermissionPolicy {
	private readonly bashToolNames: string[];
	private readonly predicateRules: PredicateRule[];
	private readonly dangerPatterns: Array<{ label: string; pattern: RegExp }>;

	/**
	 * oracle permission.rs:83-96 (`PermissionPolicy::new`). `dangerPatterns` are `[label, regex
	 * source]` pairs (mirrors the oracle's `Vec<(&'static str, &'static str)>` — raw regex
	 * strings compiled here, not pre-built `RegExp` objects) so a caller inspecting/auditing
	 * the corpus sees the same shape the oracle does. oracle: `RegexSet::new(&regexes)
	 * .expect("danger patterns must compile")` (allocation-guard, RULEBOOK §2.4) — a
	 * non-compiling pattern is a programmer error in the corpus itself, not recoverable input,
	 * so this throws eagerly rather than returning a `Result`.
	 */
	constructor(bashToolNames: string[], dangerPatterns: Array<readonly [string, string]>) {
		this.bashToolNames = bashToolNames;
		this.predicateRules = defaultPredicateRules();
		this.dangerPatterns = dangerPatterns.map(([label, source]) => {
			try {
				return { label, pattern: new RegExp(source) };
			} catch (error) {
				throw new Error(
					`danger patterns must compile: ${label} (${source}): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	}

	/** Default policy — bash tool name set + the canonical dangerous-bash corpus. oracle permission.rs:78-80. */
	static defaultForCodingAgent(): PermissionPolicy {
		return new PermissionPolicy(["bash"], defaultDangerPatterns());
	}

	/** oracle permission.rs:101-103 (`PermissionPolicy::evaluate`). Default `PermissionCategory.Tool` category. */
	evaluate(toolName: string, args: unknown): PermissionDecision {
		return this.evaluateWithCategory("tool", toolName, args);
	}

	/**
	 * oracle permission.rs:110-151 (`PermissionPolicy::evaluate_with_category`). Pure — no IO.
	 * Runtime ships a permissive default for `controlPlaneWrite` (always Allow) so adding the
	 * category is non-breaking; downstream crates wire a category-specific classifier when they
	 * opt writers into it.
	 */
	evaluateWithCategory(category: PermissionCategory, toolName: string, args: unknown): PermissionDecision {
		if (category === "controlPlaneWrite") {
			return { type: "allow" };
		}
		if (!this.bashToolNames.includes(toolName)) {
			return { type: "allow" };
		}
		const cmd = extractShellCommand(args);
		if (cmd === undefined) {
			// Empty / un-parseable bash call — allow; the tool itself will error.
			return { type: "allow" };
		}
		for (const rule of this.predicateRules) {
			if (rule.check(cmd)) {
				return { type: "deny", reason: `denied by permission policy: ${rule.label}` };
			}
		}
		for (const { label, pattern } of this.dangerPatterns) {
			if (pattern.test(cmd)) {
				return { type: "deny", reason: `denied by permission policy: ${label}` };
			}
		}
		return { type: "allow" };
	}

	/**
	 * Convert this policy into a `beforeToolCall` hook for `AgentOptions`/`BeforeToolCallContext`
	 * (packages/agent/src/types.ts). oracle permission.rs:155-170 (`as_before_tool_call`). The
	 * pi skeleton's `BeforeToolCallResult` has no `prompt` field (unlike the oracle's
	 * `BeforeToolCallResult { block, reason, prompt }`), matching this module's own
	 * `PermissionDecision` (no `Prompt` variant yet either) — nothing is lost.
	 */
	asBeforeToolCall(): (context: BeforeToolCallContext) => Promise<BeforeToolCallResult> {
		return async (context: BeforeToolCallContext) => {
			const toolCall = context.toolCall as AgentToolCall;
			const decision = this.evaluate(toolCall.name, context.args);
			if (decision.type === "allow") {
				return {};
			}
			return { block: true, reason: decision.reason };
		};
	}
}

/**
 * Try to extract the shell command from a bash tool call's argument JSON. oracle
 * permission.rs:181-196 (`extract_shell_command`). Tools accept slightly different field names,
 * so try `command`, `cmd`, `bash`, `script` in order; fall back to `args` itself if it is a
 * string.
 */
function extractShellCommand(args: unknown): string | undefined {
	if (args !== null && typeof args === "object") {
		const record = args as Record<string, unknown>;
		for (const key of ["command", "cmd", "bash", "script"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim() !== "") {
				return value;
			}
		}
	}
	if (typeof args === "string" && args.trim() !== "") {
		return args;
	}
	return undefined;
}

/**
 * The canonical "this almost certainly causes harm" corpus. oracle permission.rs:205-229
 * (`default_danger_patterns`). Patterns are anchored loosely (substring match), so flag ordering
 * for the non-`rm` rules does not matter. `rm` cases live in `defaultPredicateRules` because flag
 * permutations defeat a single-regex approach. Each entry is `[label, regex source]` — the label
 * appears in the deny reason.
 */
function defaultDangerPatterns(): Array<readonly [string, string]> {
	return [
		["sudo invocation", String.raw`\bsudo\b`],
		["curl/wget piped into shell", String.raw`\b(curl|wget)\b[^|]*\|\s*(bash|sh|zsh|fish)\b`],
		["dd writing to a block device", String.raw`\bdd\b[^\n]*\bof=/dev/(disk|sd[a-z]|nvme|hd[a-z])`],
		["mkfs / format command", String.raw`\bmkfs(\.|\s)`],
		["chmod 777 on absolute path", String.raw`\bchmod\b\s+777\s+/`],
		["shutdown / reboot / halt", String.raw`\b(shutdown|reboot|halt|poweroff)\b`],
		["git push --force on main/master", String.raw`\bgit\s+push\s+(--force|-f)\b[^\n]*\b(main|master)\b`],
		["piping into eval", String.raw`\|\s*eval\b`],
		[":(){:|:&};: forkbomb", String.raw`:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:`],
	];
}

/**
 * Token-aware predicates for rules where regex alone is fragile. oracle permission.rs:234-245
 * (`default_predicate_rules`). Currently only `rm` with recursive + force flags; intentionally
 * small so running every predicate on every bash invocation stays negligible.
 */
function defaultPredicateRules(): PredicateRule[] {
	return [
		{ label: "rm recursive+force on absolute path", check: rmRecursiveForceOnAbsoluteTarget },
		{ label: "rm recursive+force on $HOME or ~", check: rmRecursiveForceOnHomeTarget },
	];
}

/**
 * `true` when `cmd` contains an `rm` invocation bearing both a recursive flag (`-r`, `-R`,
 * `--recursive`) and a force flag (`-f`, `--force`) — combined, separated, or long-form, in any
 * order — targeting `/` or any absolute path starting with `/`. oracle permission.rs:256-258.
 */
function rmRecursiveForceOnAbsoluteTarget(cmd: string): boolean {
	return rmDangerousWith(cmd, (operand) => operand === "/" || operand.startsWith("/"));
}

/** oracle permission.rs:260-267. */
function rmRecursiveForceOnHomeTarget(cmd: string): boolean {
	return rmDangerousWith(
		cmd,
		(operand) => operand === "~" || operand.startsWith("~/") || operand === "$HOME" || operand.startsWith("$HOME/"),
	);
}

/**
 * oracle permission.rs:269-315 (`rm_dangerous_with`). Walks every shell-token cluster after the
 * first `rm` reachable through `;`, `&&`, `||`, `|`. Each operand passes through
 * `normalizeOperand` before the target check so quoting (`"/etc"`, `'$HOME/projects'`,
 * `"${HOME}/projects"`) does not bypass the classifier. False positives on contrived `rm`
 * invocations are preferable to false negatives on dangerous ones — intentionally conservative.
 */
function rmDangerousWith(cmd: string, targetMatches: (operand: string) => boolean): boolean {
	for (const clause of splitShellClauses(cmd)) {
		const tokens = clause.split(/\s+/).filter((t) => t.length > 0);
		const first = tokens[0];
		if (first === undefined) continue;
		// Strip leading path so `rm`, `/bin/rm`, `./rm` all classify.
		const prog = first.slice(first.lastIndexOf("/") + 1);
		if (prog !== "rm") continue;

		let hasRecursive = false;
		let hasForce = false;
		const operands: string[] = [];
		for (const tok of tokens.slice(1)) {
			if (tok.startsWith("--")) {
				const long = tok.slice(2);
				if (long === "recursive") hasRecursive = true;
				else if (long === "force") hasForce = true;
				// `--` end-of-options marker (long === "") is a no-op here: remaining tokens are
				// still scanned as operands by the loop below, matching the oracle's `continue`.
			} else if (tok.startsWith("-")) {
				const short = tok.slice(1);
				if (short.length === 0) {
					// bare `-` operand (stdin or path-by-convention) — treat as operand.
					operands.push(normalizeOperand(tok));
				} else {
					if (short.includes("r") || short.includes("R")) hasRecursive = true;
					if (short.includes("f")) hasForce = true;
				}
			} else {
				operands.push(normalizeOperand(tok));
			}
		}
		if (!(hasRecursive && hasForce)) continue;
		if (operands.some((op) => targetMatches(op))) return true;
	}
	return false;
}

/**
 * Normalize a single shell token before the target predicate sees it: strips one balanced layer
 * of single/double quotes and rewrites `${HOME}` (with optional suffix) to `$HOME` form. oracle
 * permission.rs:322-325. Deliberately stops short of full shell expansion.
 */
function normalizeOperand(raw: string): string {
	return rewriteBraceHome(stripOneLayerOfQuotes(raw));
}

/** oracle permission.rs:327-337. */
function stripOneLayerOfQuotes(raw: string): string {
	if (raw.length >= 2) {
		const first = raw[0];
		const last = raw[raw.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return raw.slice(1, -1);
		}
	}
	return raw;
}

/** oracle permission.rs:339-344. */
function rewriteBraceHome(raw: string): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${HOME}` shell syntax being matched, not a forgotten template literal.
	const bracedHome = "${HOME}";
	if (raw.startsWith(bracedHome)) {
		return `$HOME${raw.slice(bracedHome.length)}`;
	}
	return raw;
}

/**
 * Split a shell command line on `;`, `&&`, `||`, `|`. oracle permission.rs:346-379
 * (`split_shell_clauses`). Deliberately dumb — does not honor quotes/escapes; a quoted `;` inside
 * a string just produces an extra clause that is still scanned honestly.
 */
function splitShellClauses(cmd: string): string[] {
	const out: string[] = [];
	let start = 0;
	let i = 0;
	while (i < cmd.length) {
		const c = cmd[i];
		if (c === ";") {
			out.push(cmd.slice(start, i).trim());
			start = i + 1;
			i += 1;
		} else if (i + 1 < cmd.length && ((c === "&" && cmd[i + 1] === "&") || (c === "|" && cmd[i + 1] === "|"))) {
			out.push(cmd.slice(start, i).trim());
			start = i + 2;
			i += 2;
		} else if (c === "|") {
			out.push(cmd.slice(start, i).trim());
			start = i + 1;
			i += 1;
		} else {
			i += 1;
		}
	}
	if (start <= cmd.length) {
		out.push(cmd.slice(start).trim());
	}
	return out.filter((s) => s.length > 0);
}
