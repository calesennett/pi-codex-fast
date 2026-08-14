import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "fast-priority";
const SETTINGS_KEY = "pi-codex-fast";
const FAST_MODELS = [
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.5",
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.6-terra",
	"openai-codex/gpt-5.6-luna",
];
const ULTRAFAST_MODELS = ["openai/gpt-5.6-sol"];

type SpeedMode = "off" | "fast" | "ultrafast";

function currentModelName(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function supportsSpeedMode(ctx: ExtensionContext, mode: SpeedMode): boolean {
	if (mode === "off") return false;
	const modelName = currentModelName(ctx);
	const supportedModels = mode === "fast" ? FAST_MODELS : ULTRAFAST_MODELS;
	return modelName !== undefined && supportedModels.includes(modelName);
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function globalSettingsPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
	try {
		const content = await readFile(path, "utf8");
		return asObject(JSON.parse(content)) ?? {};
	} catch (error) {
		if (asObject(error)?.code === "ENOENT") return {};
		throw error;
	}
}

function speedModeFromSettings(settings: Record<string, unknown>): SpeedMode | undefined {
	const extensionSettings = asObject(settings[SETTINGS_KEY]);
	const mode = extensionSettings?.mode;
	if (mode === "off" || mode === "fast" || mode === "ultrafast") return mode;
	const legacyEnabled = extensionSettings?.enabled;
	if (typeof legacyEnabled !== "boolean") return undefined;
	return legacyEnabled ? "fast" : "off";
}

async function loadPersistedSpeedMode(cwd: string): Promise<SpeedMode | undefined> {
	const globalMode = speedModeFromSettings(await readSettings(globalSettingsPath()));
	const projectMode = speedModeFromSettings(await readSettings(projectSettingsPath(cwd)));
	return projectMode ?? globalMode;
}

async function persistSpeedMode(mode: SpeedMode): Promise<void> {
	const path = globalSettingsPath();
	const globalSettings = await readSettings(path);
	const extensionSettings = asObject(globalSettings[SETTINGS_KEY]) ?? {};
	globalSettings[SETTINGS_KEY] = {
		...extensionSettings,
		enabled: mode !== "off",
		mode,
	};
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(globalSettings, null, 2)}\n`);
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	let speedMode: SpeedMode = "off";
	let settingsWriteQueue: Promise<void> = Promise.resolve();

	function persistState(mode: SpeedMode, ctx: ExtensionContext): void {
		settingsWriteQueue = settingsWriteQueue
			.catch(() => undefined)
			.then(() => persistSpeedMode(mode));

		void settingsWriteQueue.catch((error) => {
			if (!ctx.hasUI) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-codex-fast: failed to write settings: ${message}`, "warning");
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (speedMode === "off") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const label = speedMode === "fast" ? "Fast" : "Ultrafast";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", label));
	}

	function notifyState(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (speedMode === "off") {
			ctx.ui.notify("Speed mode disabled. Requests will use the default service tier.", "info");
			return;
		}

		const modeLabel = speedMode === "fast" ? "Fast" : "Ultrafast";
		const modelLabel = currentModelName(ctx) ?? "no active model";
		if (supportsSpeedMode(ctx, speedMode)) {
			ctx.ui.notify(`${modeLabel} mode enabled (${modelLabel}).`, "info");
			return;
		}

		ctx.ui.notify(`${modeLabel} mode enabled but inactive (${modelLabel}).`, "info");
	}

	function setSpeedMode(mode: SpeedMode, ctx: ExtensionContext, options?: { persist?: boolean; notify?: boolean }): void {
		speedMode = mode;
		if (options?.persist !== false) persistState(mode, ctx);
		updateStatus(ctx);
		if (options?.notify !== false) notifyState(ctx);
	}

	function toggleSpeedMode(mode: "fast" | "ultrafast", ctx: ExtensionContext): void {
		setSpeedMode(speedMode === mode ? "off" : mode, ctx);
	}

	async function reloadSpeedModeState(ctx: ExtensionContext, options?: { includeStartupFlag?: boolean }): Promise<void> {
		speedMode = "off";

		try {
			const persistedMode = await loadPersistedSpeedMode(ctx.cwd);
			if (persistedMode !== undefined) speedMode = persistedMode;
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`pi-codex-fast: failed to load settings: ${message}`, "warning");
			}
		}

		if (options?.includeStartupFlag) {
			if (pi.getFlag("fast") === true) speedMode = "fast";
			if (pi.getFlag("ultrafast") === true) speedMode = "ultrafast";
		}

		updateStatus(ctx);
	}

	pi.registerFlag("fast", {
		description: "Start with fast mode enabled",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("ultrafast", {
		description: "Start with ultrafast mode enabled",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle fast mode",
		handler: async (_args, ctx) => {
			toggleSpeedMode("fast", ctx);
		},
	});

	pi.registerCommand("codex-ultrafast", {
		description: "Toggle ultrafast mode",
		handler: async (_args, ctx) => {
			toggleSpeedMode("ultrafast", ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await reloadSpeedModeState(ctx, { includeStartupFlag: true });
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (speedMode === "off" || !supportsSpeedMode(ctx, speedMode)) return;
		const payload = asObject(event.payload);
		if (payload === null) return;

		return {
			...payload,
			service_tier: speedMode === "fast" ? "priority" : "ultrafast",
		};
	});
}
