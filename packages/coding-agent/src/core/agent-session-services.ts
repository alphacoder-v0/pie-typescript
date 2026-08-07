import { join } from "node:path";
import type { ThinkingLevel } from "@pie/agent-core";
import type { Model } from "@pie/ai";
import { unexpectedArgument } from "../cli/usage-error.ts";
import { getAgentDir } from "../config.ts";
import { asAfterToolCallHook, LspSupervisor } from "../lsp-supervisor.ts";
import { type LoadedMcp, loadAll as loadAllMcp } from "../mcp-loader.ts";
import { AuthStorage } from "./auth-storage.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { ModelRegistry } from "./model-registry.ts";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
	/**
	 * Set when this "error" is a CLI *usage* error rather than a runtime failure: the value is
	 * clap's page, already rendered (`cli/usage-error.ts`), and the CLI writes it to stderr verbatim
	 * and exits 2 instead of printing `message` and exiting 1.
	 *
	 * Only one diagnostic can be this: an unknown `--flag`. Oracle has no extensions, so clap
	 * rejects an unrecognized long flag during parsing; here it has to survive until the extension
	 * catalog is loaded, because that is the only thing that can say whether an extension declared
	 * it. What must not survive is the *shape* of the answer — phase 19 F9/F13 measured exit 1 and a
	 * bare `Error: Unknown option: --no-such-flag` where oracle exits 2 with a usage block.
	 *
	 * Embedders that read diagnostics as data (the SDK path) can ignore this and keep using
	 * `message`, which still carries the full list when several flags are unknown.
	 */
	usageError?: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	authStorage?: AuthStorage;
	settingsManager?: SettingsManager;
	modelRegistry?: ModelRegistry;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	/**
	 * Control-plane prompt hook. pie: main.rs:754-767 picks it from the CLI flags; forwarded
	 * verbatim to {@link CreateAgentSessionOptions.onControlPlanePrompt}, which falls back to
	 * oracle's fail-closed deny when this is omitted.
	 */
	onControlPlanePrompt?: CreateAgentSessionOptions["onControlPlanePrompt"];
	/**
	 * Stream-backend decorator. pie: main.rs:607-612 (`--debug` -> `debug::wrap_stream_fn`).
	 * Forwarded verbatim to {@link CreateAgentSessionOptions.wrapStreamFn}.
	 */
	wrapStreamFn?: CreateAgentSessionOptions["wrapStreamFn"];
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	/**
	 * MCP servers spawned for this cwd. pie: main.rs:660 (`mcp_loader::load_all(&cwd).await`).
	 * `tools` are appended to the registry; `notificationHooks` / `injectSummaryServers` /
	 * `injectAndRunServers` are carried here for the trigger-runtime wiring
	 * (main.rs:769-780, :817-825), which lands with the `coding-agent/tui` unit.
	 */
	mcp: LoadedMcp;
	/** LSP feedback loop. pie: main.rs:783 (`LspSupervisor::load(&cwd).await`). */
	lspSupervisor: LspSupervisor;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
			// clap stops at the first unrecognized argument and names only that one; the aggregated
			// `message` above stays for embedders that read diagnostics as data.
			usageError: unexpectedArgument(`--${unknownFlags[0]}`),
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = options.cwd;
	const agentDir = options.agentDir ?? getAgentDir();
	const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload();

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRegistry.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	// MCP (issue #9): spawn every server configured under ~/.pie/mcp.toml or <cwd>/.pie/mcp.toml
	// and append their tools to the registry. pie: main.rs:657-672.
	//
	// PORT-DIVERGENCE: B5 — oracle reads the project-local `<cwd>/.pie/mcp.toml` here and spawns
	// its stdio servers with no trust gate, letting a project entry silently override a same-named
	// user entry (`mcp_loader.rs:98-139, 239-253`). This call site is what made that reachable:
	// creating services for a cwd was enough to execute commands from a file inside it. Phase 18
	// gates the project half inside `loadAll` itself (`core/project-trust.ts`) rather than here, so
	// every caller — including the SDK and future call sites — inherits the gate instead of having
	// to remember it.
	const mcp = await loadAllMcp(cwd);
	for (const diagnostic of mcp.diagnostics) {
		// pie: main.rs:998-1000 — `app.error_line(format!("mcp: {diag}"))`.
		diagnostics.push({ type: "error", message: `mcp: ${diagnostic}` });
	}

	// LSP feedback loop (issue #12): attach diagnostics to write/edit tool results when
	// ~/.pie/lsp.toml or <cwd>/.pie/lsp.toml is configured. pie: main.rs:781-787.
	//
	// PORT-DIVERGENCE: B13 — same missing trust gate as B5 in oracle (`lsp_supervisor.rs:76-103`),
	// with a lazy spawn (first write/edit touching a configured extension), which made it quieter
	// rather than safer. Gated the same way and in the same place: inside `LspSupervisor.load`.
	const lspSupervisor = await LspSupervisor.load(cwd);

	return {
		cwd,
		agentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoader,
		mcp,
		lspSupervisor,
		diagnostics,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	const { mcp, lspSupervisor } = options.services;
	// pie: main.rs:672 (`tools.extend(mcp.tools)`) — MCP tools join the registry alongside the
	// built-ins. `AgentTool` -> `ToolDefinition` is the shape the TS registry speaks.
	const mcpTools = mcp.tools.map(createToolDefinitionFromAgentTool);
	const customTools = mcpTools.length > 0 ? [...(options.customTools ?? []), ...mcpTools] : options.customTools;
	// pie: main.rs:785-787 — the hook is installed ONLY when the supervisor has configured
	// languages (`if !lsp_supervisor.is_empty()`), so an unconfigured install pays nothing.
	const afterToolCallHook = lspSupervisor.isEmpty() ? undefined : asAfterToolCallHook(lspSupervisor);

	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		noTools: options.noTools,
		customTools,
		afterToolCallHook,
		onControlPlanePrompt: options.onControlPlanePrompt,
		wrapStreamFn: options.wrapStreamFn,
		sessionStartEvent: options.sessionStartEvent,
	});
}
