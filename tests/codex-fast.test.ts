import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codexFastExtension from "../extensions/codex-fast.ts";

type Flags = Record<string, string | boolean>;
type Handler = (event: { payload?: unknown }, ctx: ExtensionContext) => unknown;

const setup = async (t: TestContext, flags: Flags, globalMode: unknown, projectMode?: unknown) => {
	const root = await mkdtemp(join(tmpdir(), "pi-codex-fast-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	});

	const paths = [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")];
	const settings = [globalMode, projectMode].map((value) => JSON.stringify({ "pi-codex-fast": value, untouched: true }));
	await Promise.all(paths.map((path, index) => writeFile(path, settings[index])));
	const handlers = new Map<string, Handler>();
	const status = new Map<string, string | undefined>([["fast-priority", "stale status"]]);
	let shutdown = false;
	const ctx = {
		cwd,
		hasUI: true,
		model: { provider: "openai-codex", id: "gpt-5.6-terra" },
		shutdown: () => { shutdown = true; },
		ui: {
			setStatus: (key: string, value: string | undefined) => status.set(key, value),
			notify: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	codexFastExtension({
		registerFlag: () => {},
		registerCommand: () => {},
		getFlag: (name: string) => flags[name],
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);

	return {
		ctx,
		status,
		isShutdown: () => shutdown,
		emit: (name: string, payload?: unknown) => handlers.get(name)?.({ payload }, ctx),
		assertUnchanged: async () => assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), settings),
	};
};

const testCases: { name: string; flags: Flags; global: unknown; project?: unknown; tier?: string }[] = [
	{ name: "off overrides saved fast", flags: { speed: "off" }, global: { mode: "fast" }, tier: undefined },
	{ name: "off overrides project ultrafast", flags: { speed: "off" }, global: { mode: "off" }, project: { mode: "ultrafast" }, tier: undefined },
	{ name: "fast overrides project off", flags: { speed: "fast" }, global: { mode: "ultrafast" }, project: { mode: "off" }, tier: "priority" },
	{ name: "ultrafast overrides saved fast", flags: { speed: "ultrafast" }, global: { mode: "fast" }, tier: "ultrafast" },
	{ name: "omitted preserves saved fast", flags: {}, global: { mode: "fast" }, tier: "priority" },
	{ name: "omitted preserves project off", flags: {}, global: { mode: "fast" }, project: { mode: "off" }, tier: undefined },
	{ name: "omitted preserves project ultrafast", flags: {}, global: { mode: "off" }, project: { mode: "ultrafast" }, tier: "ultrafast" },
	{ name: "omitted preserves legacy enabled", flags: {}, global: { enabled: true }, tier: "priority" },
	{ name: "omitted defaults to off", flags: {}, global: {}, tier: undefined },
	{ name: "legacy fast", flags: { fast: true }, global: { mode: "off" }, tier: "priority" },
	{ name: "legacy ultrafast", flags: { ultrafast: true }, global: { mode: "off" }, tier: "ultrafast" },
	{ name: "matching fast flags", flags: { speed: "fast", fast: true }, global: {}, tier: "priority" },
	{ name: "matching ultrafast flags", flags: { speed: "ultrafast", ultrafast: true }, global: {}, tier: "ultrafast" },
];

for (const testCase of testCases) {
	test(testCase.name, async (t) => {
		const harness = await setup(t, testCase.flags, testCase.global, testCase.project);
		if (testCase.tier === "ultrafast") Object.assign(harness.ctx, { model: { provider: "openai", id: "gpt-5.6-sol" } });
		await harness.emit("session_start");
		const payload = { model: "test", messages: [] };
		assert.deepEqual(harness.emit("before_provider_request", payload), testCase.tier ? { ...payload, service_tier: testCase.tier } : undefined);
		assert.deepEqual(payload, { model: "test", messages: [] });
		const label = testCase.tier === "priority" ? "Fast" : testCase.tier === "ultrafast" ? "Ultrafast" : undefined;
		assert.equal(harness.status.get("fast-priority"), label);
		harness.emit("model_select");
		assert.equal(harness.status.get("fast-priority"), label);
		assert.equal(harness.isShutdown(), false);
		assert.equal(harness.emit("input"), undefined);
		await harness.assertUnchanged();
	});
}

const invalidCases: Flags[] = [
	{ speed: "slow" }, { speed: "" }, { speed: true },
	{ fast: true, ultrafast: true },
	{ speed: "off", fast: true }, { speed: "off", ultrafast: true },
	{ speed: "fast", ultrafast: true }, { speed: "ultrafast", fast: true },
];
for (const flags of invalidCases) {
	test(`rejects ${JSON.stringify(flags)}`, async (t) => {
		const harness = await setup(t, flags, { mode: "fast" });
		await assert.rejects(async () => harness.emit("session_start"), /pi-codex-fast:.*(?:--speed must be|conflicting)/);
		assert.equal(harness.isShutdown(), true);
		assert.deepEqual(harness.emit("input"), { action: "handled" });
		assert.equal(harness.status.get("fast-priority"), undefined);
		assert.equal(harness.emit("before_provider_request", {}), undefined);
		await harness.assertUnchanged();
	});
}

test("unsupported models and non-object payloads remain unchanged", async (t) => {
	const harness = await setup(t, { speed: "fast" }, {});
	await harness.emit("session_start");
	for (const payload of [null, [], "text"]) assert.equal(harness.emit("before_provider_request", payload), undefined);
	Object.assign(harness.ctx, { model: { provider: "anthropic", id: "claude-sonnet-4-6" } });
	assert.equal(harness.emit("before_provider_request", {}), undefined);
});

test("off works without a UI", async (t) => {
	const harness = await setup(t, { speed: "off" }, { mode: "fast" });
	Object.assign(harness.ctx, { hasUI: false, ui: undefined });
	await harness.emit("session_start");
	assert.equal(harness.emit("before_provider_request", {}), undefined);
	await harness.assertUnchanged();
});
