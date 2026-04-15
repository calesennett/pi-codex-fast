import { SettingsManager, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "fast-priority";
const SETTINGS_KEY = "pi-codex-fast";
const PRIORITY_COST_MULTIPLIER = 2;

interface UsageCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

interface AssistantUsage {
	cost?: UsageCost;
}

interface AssistantLikeMessage {
	role?: string;
	usage?: AssistantUsage;
}

type InternalSettingsManager = SettingsManager & {
	globalSettings: Record<string, unknown>;
	markModified(field: string, nestedKey?: string): void;
	save(): void;
};

const settingsManagers = new Map<string, SettingsManager>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportsPriorityServiceTier(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai" || ctx.model?.provider === "openai-codex";
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function getSettingsManager(cwd: string): SettingsManager {
	const existing = settingsManagers.get(cwd);
	if (existing) return existing;

	const settingsManager = SettingsManager.create(cwd);
	settingsManagers.set(cwd, settingsManager);
	return settingsManager;
}

function mergeSettings(
	base: Record<string, unknown>,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(overrides)) {
		const baseValue = merged[key];
		if (isRecord(baseValue) && isRecord(overrideValue)) {
			merged[key] = mergeSettings(baseValue, overrideValue);
			continue;
		}
		merged[key] = overrideValue;
	}
	return merged;
}

function getEffectiveSettings(settingsManager: SettingsManager): Record<string, unknown> {
	return mergeSettings(
		settingsManager.getGlobalSettings() as Record<string, unknown>,
		settingsManager.getProjectSettings() as Record<string, unknown>,
	);
}

function loadPersistedFastMode(cwd: string): boolean | undefined {
	const settingsManager = getSettingsManager(cwd);
	settingsManager.reload();
	const settings = getEffectiveSettings(settingsManager);
	const extensionSettings = asObject(settings[SETTINGS_KEY]);
	return typeof extensionSettings?.enabled === "boolean" ? extensionSettings.enabled : undefined;
}

function persistFastMode(enabled: boolean, cwd: string): SettingsManager {
	const settingsManager = getSettingsManager(cwd) as InternalSettingsManager;
	settingsManager.reload();
	const globalSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
	const extensionSettings = asObject(globalSettings[SETTINGS_KEY]) ?? {};
	settingsManager.globalSettings[SETTINGS_KEY] = {
		...extensionSettings,
		enabled,
	};
	settingsManager.markModified(SETTINGS_KEY);
	settingsManager.save();
	return settingsManager;
}

function reportSettingsErrors(settingsManager: SettingsManager, ctx: ExtensionContext, action: "load" | "write"): void {
	if (!ctx.hasUI) return;
	for (const { scope, error } of settingsManager.drainErrors()) {
		ctx.ui.notify(`pi-codex-fast: failed to ${action} ${scope} settings: ${error.message}`, "warning");
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function cloneUsageCost(cost: UsageCost): UsageCost {
	return { ...cost };
}

export function applyPriorityCostMultiplier(cost: UsageCost, multiplier = PRIORITY_COST_MULTIPLIER): UsageCost {
	const adjusted = cloneUsageCost(cost);

	if (isFiniteNumber(adjusted.input)) adjusted.input *= multiplier;
	if (isFiniteNumber(adjusted.output)) adjusted.output *= multiplier;
	if (isFiniteNumber(adjusted.cacheRead)) adjusted.cacheRead *= multiplier;
	if (isFiniteNumber(adjusted.cacheWrite)) adjusted.cacheWrite *= multiplier;
	if (isFiniteNumber(adjusted.total)) adjusted.total *= multiplier;

	return adjusted;
}

export function adjustAssistantMessageCost(message: AssistantLikeMessage, multiplier = PRIORITY_COST_MULTIPLIER): boolean {
	if (message.role !== "assistant") return false;
	if (!message.usage?.cost) return false;

	message.usage.cost = applyPriorityCostMultiplier(message.usage.cost, multiplier);
	return true;
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	let fastModeEnabled = false;
	let settingsWriteQueue: Promise<void> = Promise.resolve();
	const adjustedMessages = new WeakSet<object>();

	function maybeAdjustMessageCost(message: AssistantLikeMessage | undefined): void {
		if (!fastModeEnabled || !message || adjustedMessages.has(message as object)) {
			return;
		}
		if (adjustAssistantMessageCost(message)) {
			adjustedMessages.add(message as object);
		}
	}

	function persistState(enabled: boolean, ctx: ExtensionContext): void {
		const cwd = ctx.cwd;
		settingsWriteQueue = settingsWriteQueue
			.catch(() => undefined)
			.then(async () => {
				const settingsManager = persistFastMode(enabled, cwd);
				await settingsManager.flush();
				reportSettingsErrors(settingsManager, ctx, "write");
			});

		void settingsWriteQueue.catch((error) => {
			if (!ctx.hasUI) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-codex-fast: failed to write settings: ${message}`, "warning");
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!fastModeEnabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const label = supportsPriorityServiceTier(ctx) ? "⚡ OpenAI fast mode" : "⚡ fast (inactive)";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", label));
	}

	function notifyState(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!fastModeEnabled) {
			ctx.ui.notify("Fast mode disabled. OpenAI/OpenAI Codex requests will use the default service tier.", "info");
			return;
		}

		if (supportsPriorityServiceTier(ctx)) {
			ctx.ui.notify("Fast mode enabled. OpenAI/OpenAI Codex requests will send service_tier=priority and cost will be tracked at 2x.", "info");
			return;
		}

		const modelLabel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model";
		ctx.ui.notify(
			`Fast mode enabled. It will apply once you switch to an OpenAI or OpenAI Codex model (current: ${modelLabel}).`,
			"info",
		);
	}

	function setFastMode(enabled: boolean, ctx: ExtensionContext, options?: { persist?: boolean; notify?: boolean }): void {
		fastModeEnabled = enabled;
		if (options?.persist !== false) persistState(enabled, ctx);
		updateStatus(ctx);
		if (options?.notify !== false) notifyState(ctx);
	}

	async function reloadFastModeState(ctx: ExtensionContext, options?: { includeStartupFlag?: boolean }): Promise<void> {
		await settingsWriteQueue.catch(() => undefined);
		fastModeEnabled = false;

		try {
			const settingsManager = getSettingsManager(ctx.cwd);
			const persistedEnabled = loadPersistedFastMode(ctx.cwd);
			reportSettingsErrors(settingsManager, ctx, "load");
			if (typeof persistedEnabled === "boolean") {
				fastModeEnabled = persistedEnabled;
			}
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`pi-codex-fast: failed to load settings: ${message}`, "warning");
			}
		}

		if (options?.includeStartupFlag && pi.getFlag("fast") === true) {
			fastModeEnabled = true;
		}

		updateStatus(ctx);
	}

	pi.registerFlag("fast", {
		description: "Start with fast mode enabled (adds service_tier=priority to OpenAI/OpenAI Codex requests)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle OpenAI/OpenAI Codex priority service tier",
		handler: async (_args, ctx) => {
			setFastMode(!fastModeEnabled, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await reloadFastModeState(ctx, { includeStartupFlag: true });
	});

	pi.on("session_switch", async (_event, ctx) => {
		await reloadFastModeState(ctx, { includeStartupFlag: true });
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!supportsPriorityServiceTier(ctx)) return;
		maybeAdjustMessageCost(event.message as AssistantLikeMessage);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!supportsPriorityServiceTier(ctx)) return;
		maybeAdjustMessageCost(event.message as AssistantLikeMessage);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastModeEnabled || !supportsPriorityServiceTier(ctx) || !isRecord(event.payload)) {
			return;
		}

		if (Object.prototype.hasOwnProperty.call(event.payload, "service_tier")) {
			return;
		}

		return {
			...event.payload,
			service_tier: "priority",
		};
	});
}
