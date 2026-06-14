#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULTS = {
	trials: 3,
	model: "openai-codex/gpt-5.5",
	pi: "pi",
	extension: "./extensions/codex-fast.ts",
	promptFile: "evals/prompts/lru-cache.txt",
};

function usage() {
	return `Usage: node evals/codex-fast-bench.mjs [options]\n\nOptions:\n  --trials <n>        Number of paired trials (default: ${DEFAULTS.trials})\n  --model <model>     Codex model to benchmark (default: ${DEFAULTS.model})\n  --pi <path>         pi executable path (default: ${DEFAULTS.pi})\n  --extension <path>  codex-fast extension path (default: ${DEFAULTS.extension})\n  --prompt-file <p>   Benchmark prompt file (default: ${DEFAULTS.promptFile})\n  --help              Show this help\n`;
}

function optionValue(argv, index, inlineValue) {
	if (inlineValue !== undefined) return inlineValue;
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for ${argv[index]}`);
	}
	return value;
}

function parseArgs(argv) {
	const options = { ...DEFAULTS };
	for (let i = 0; i < argv.length; i += 1) {
		const raw = argv[i];
		const eq = raw.indexOf("=");
		const flag = eq === -1 ? raw : raw.slice(0, eq);
		const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);

		switch (flag) {
			case "--help":
			case "-h":
				options.help = true;
				break;
			case "--trials": {
				const value = optionValue(argv, i, inlineValue);
				if (inlineValue === undefined) i += 1;
				options.trials = Number.parseInt(value, 10);
				break;
			}
			case "--model": {
				const value = optionValue(argv, i, inlineValue);
				if (inlineValue === undefined) i += 1;
				options.model = value;
				break;
			}
			case "--pi": {
				const value = optionValue(argv, i, inlineValue);
				if (inlineValue === undefined) i += 1;
				options.pi = value;
				break;
			}
			case "--extension": {
				const value = optionValue(argv, i, inlineValue);
				if (inlineValue === undefined) i += 1;
				options.extension = value;
				break;
			}
			case "--prompt-file": {
				const value = optionValue(argv, i, inlineValue);
				if (inlineValue === undefined) i += 1;
				options.promptFile = value;
				break;
			}
			default:
				throw new Error(`Unknown option: ${raw}`);
		}
	}

	if (!Number.isInteger(options.trials) || options.trials < 1) {
		throw new Error("--trials must be a positive integer");
	}
	return options;
}

function nowMark() {
	const ms = performance.timeOrigin + performance.now();
	return { ms, iso: new Date(ms).toISOString() };
}

function durationMs(start, end) {
	return typeof start === "number" && typeof end === "number" ? end - start : null;
}

function textDelta(event) {
	const update = event?.assistantMessageEvent;
	return update?.type === "text_delta" && typeof update.delta === "string" ? update.delta : "";
}

function hasTextContentUpdate(event) {
	const update = event?.assistantMessageEvent;
	if (!update || typeof update.type !== "string") return false;
	if (update.type === "text_delta") return typeof update.delta === "string" && update.delta.length > 0;
	if (update.type === "text_end") return typeof update.content === "string" && update.content.length > 0;
	return false;
}

function textLengthFromContent(content) {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const part of content) {
		if (typeof part === "string") {
			total += part.length;
		} else if (part && typeof part === "object") {
			if (typeof part.text === "string") total += part.text.length;
			else if (typeof part.content === "string") total += part.content.length;
		}
	}
	return total;
}

function contentTypes(content) {
	if (typeof content === "string") return ["text"];
	if (!Array.isArray(content)) return [];
	return content.map((part) => {
		if (typeof part === "string") return "text";
		if (part && typeof part === "object" && typeof part.type === "string") return part.type;
		return typeof part;
	});
}

function compactMessage(message) {
	if (!message || typeof message !== "object") return message;
	return {
		role: message.role,
		api: message.api,
		provider: message.provider,
		model: message.model,
		usage: message.usage,
		stopReason: message.stopReason,
		timestamp: message.timestamp,
		contentItems: Array.isArray(message.content) ? message.content.length : typeof message.content === "string" ? 1 : 0,
		contentTypes: contentTypes(message.content),
		contentChars: textLengthFromContent(message.content),
	};
}

function compactToolResult(result) {
	if (!result || typeof result !== "object") return result;
	return {
		role: result.role,
		toolCallId: result.toolCallId,
		toolName: result.toolName,
		isError: result.isError,
		contentChars: textLengthFromContent(result.content),
	};
}

function compactAssistantMessageEvent(update) {
	if (!update || typeof update !== "object") return update;
	const compact = { type: update.type };
	if (typeof update.contentIndex === "number") compact.contentIndex = update.contentIndex;
	if (typeof update.delta === "string") compact.deltaChars = update.delta.length;
	if (typeof update.content === "string") compact.contentChars = update.content.length;
	if (typeof update.thinking === "string") compact.thinkingChars = update.thinking.length;
	if (typeof update.signature === "string") compact.signatureChars = update.signature.length;
	return compact;
}

function compactEvent(event) {
	if (!event || typeof event !== "object") return event;
	if (event.type === "message_update") {
		return {
			type: event.type,
			assistantMessageEvent: compactAssistantMessageEvent(event.assistantMessageEvent),
		};
	}
	if (event.type === "message_start" || event.type === "message_end") {
		return { type: event.type, message: compactMessage(event.message) };
	}
	if (event.type === "turn_end") {
		return {
			type: event.type,
			message: compactMessage(event.message),
			toolResults: Array.isArray(event.toolResults) ? event.toolResults.map(compactToolResult) : event.toolResults,
		};
	}
	if (event.type === "agent_end") {
		return {
			type: event.type,
			messageCount: Array.isArray(event.messages) ? event.messages.length : undefined,
			willRetry: event.willRetry,
		};
	}
	return event;
}

function parseJsonLine(line, context) {
	try {
		return JSON.parse(line);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const preview = line.length > 500 ? `${line.slice(0, 500)}...` : line;
		throw new Error(`Invalid JSON from pi during ${context}: ${message}\nLine: ${preview}`);
	}
}

function buildArgs(kind, options, prompt) {
	const args = [
		"--mode", "json",
		"--no-session",
		"--no-tools",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--model", options.model,
		"--no-extensions",
	];

	if (kind === "fast") {
		// Use an explicit boolean value so the extension flag cannot consume the
		// following positional prompt on pi versions with permissive flag parsing.
		args.push("-e", options.extension, "--fast=true");
	}

	args.push(prompt);
	return args;
}

function runPiInvocation({ kind, trial, ordinal, options, prompt }) {
	const args = buildArgs(kind, options, prompt);
	const command = [options.pi, ...args.slice(0, -1), "<prompt>"].join(" ");
	const result = {
		trial,
		ordinal,
		kind,
		command,
		args: args.slice(0, -1).concat("<prompt>"),
		timestamps: {},
		metrics: {},
		events: [],
		stderr: "",
		exitCode: null,
		signal: null,
	};

	return new Promise((resolveRun, rejectRun) => {
		let settled = false;
		let stdoutBuffer = "";
		let outputChars = 0;
		let turnEndEvent = null;
		let child;

		function fail(error) {
			if (settled) return;
			settled = true;
			result.error = error instanceof Error ? error.message : String(error);
			result.timestamps.exit ??= nowMark();
			if (child && !child.killed) child.kill();
			rejectRun(error);
		}

		function finish() {
			if (settled) return;
			try {
				if (stdoutBuffer.trim().length > 0) processLine(stdoutBuffer);
			} catch (error) {
				fail(error);
				return;
			}
			settled = true;

			if (outputChars === 0 && turnEndEvent) {
				outputChars = textLengthFromContent(turnEndEvent.message?.content);
			}

			const t = result.timestamps;
			result.metrics = {
				ttfbMs: durationMs(t.spawn?.ms, t.firstText?.ms),
				turnDurationMs: durationMs(t.turnStart?.ms, t.turnEnd?.ms),
				wallDurationMs: durationMs(t.spawn?.ms, t.exit?.ms),
				outputChars,
			};
			resolveRun(result);
		}

		function processLine(line) {
			const trimmed = line.trim();
			if (!trimmed) return;
			const received = nowMark();
			const event = parseJsonLine(trimmed, `${kind} trial ${trial}`);

			result.events.push({ received, event: compactEvent(event) });
			if (event.type === "turn_start" && !result.timestamps.turnStart) {
				result.timestamps.turnStart = received;
			}
			if (event.type === "message_update") {
				const delta = textDelta(event);
				outputChars += delta.length;
				if (!result.timestamps.firstText && hasTextContentUpdate(event)) {
					result.timestamps.firstText = received;
				}
			}
			if (event.type === "turn_end" && !result.timestamps.turnEnd) {
				result.timestamps.turnEnd = received;
				turnEndEvent = event;
			}
		}

		const preSpawn = nowMark();
		child = spawn(options.pi, args, {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		result.pid = child.pid ?? null;
		child.once("spawn", () => {
			result.timestamps.spawn = nowMark();
		});

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			try {
				stdoutBuffer += chunk;
				let newlineIndex;
				while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
					const line = stdoutBuffer.slice(0, newlineIndex);
					stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
					processLine(line);
				}
			} catch (error) {
				fail(error);
			}
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			result.stderr += chunk;
		});

		child.once("error", (error) => {
			result.timestamps.spawn ??= preSpawn;
			result.timestamps.exit = nowMark();
			fail(error);
		});

		child.once("close", (code, signal) => {
			result.exitCode = code;
			result.signal = signal;
			result.timestamps.spawn ??= preSpawn;
			result.timestamps.exit = nowMark();
			finish();
		});
	});
}

function median(values) {
	const nums = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
	if (nums.length === 0) return null;
	const mid = Math.floor(nums.length / 2);
	return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

function fmtMs(value) {
	return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}ms` : "n/a";
}

function fmtInt(value) {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function fmtRatio(value) {
	return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}x` : "n/a";
}

function printTable(headers, rows) {
	const widths = headers.map((header, index) => Math.max(
		header.length,
		...rows.map((row) => String(row[index] ?? "").length),
	));
	const formatRow = (row) => row.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ");
	console.log(formatRow(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of rows) console.log(formatRow(row));
}

function statusOf(result) {
	if (result.error) return "spawn-error";
	if (result.exitCode !== 0) return `exit ${result.exitCode}`;
	if (!result.timestamps.turnEnd) return "no-turn";
	return "ok";
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error(usage());
		process.exitCode = 2;
		return;
	}

	if (options.help) {
		console.log(usage());
		return;
	}

	const prompt = await readFile(options.promptFile, "utf8");
	if (prompt.trim().length === 0) throw new Error(`Prompt file is empty: ${options.promptFile}`);

	const totalRuns = options.trials * 2;
	const results = [];
	let ordinal = 0;

	console.log(`Running ${options.trials} paired trial(s) with ${options.model}`);
	console.log(`Prompt: ${options.promptFile}`);
	console.log(`Extension: ${options.extension}\n`);

	for (let trial = 1; trial <= options.trials; trial += 1) {
		const order = trial % 2 === 1 ? ["baseline", "fast"] : ["fast", "baseline"];
		for (const kind of order) {
			ordinal += 1;
			process.stdout.write(`[${ordinal}/${totalRuns}] trial ${trial} ${kind} ... `);
			const result = await runPiInvocation({ kind, trial, ordinal, options, prompt });
			results.push(result);
			console.log(`${statusOf(result)} (${fmtMs(result.metrics.wallDurationMs)}, ${fmtInt(result.metrics.outputChars)} chars)`);
		}
	}

	const startedAt = new Date().toISOString();
	const outPath = `evals/results/codex-fast-${startedAt.replace(/[:.]/g, "-")}.json`;
	await mkdir(dirname(outPath), { recursive: true });
	await writeFile(outPath, `${JSON.stringify({
		createdAt: startedAt,
		options: {
			...options,
			promptFile: options.promptFile,
			promptFileResolved: resolve(options.promptFile),
			extensionResolved: resolve(options.extension),
		},
		prompt,
		results,
	}, null, 2)}\n`);

	console.log("\nRuns");
	printTable(
		["trial", "run", "variant", "TTFB", "turn", "wall", "chars", "status"],
		results.map((result) => [
			result.trial,
			result.ordinal,
			result.kind,
			fmtMs(result.metrics.ttfbMs),
			fmtMs(result.metrics.turnDurationMs),
			fmtMs(result.metrics.wallDurationMs),
			fmtInt(result.metrics.outputChars),
			statusOf(result),
		]),
	);

	const byKind = {
		baseline: results.filter((result) => result.kind === "baseline"),
		fast: results.filter((result) => result.kind === "fast"),
	};
	const med = (kind, metric) => median(byKind[kind].map((result) => result.metrics[metric]));
	const medianRows = [
		["TTFB", med("baseline", "ttfbMs"), med("fast", "ttfbMs")],
		["turn", med("baseline", "turnDurationMs"), med("fast", "turnDurationMs")],
		["wall", med("baseline", "wallDurationMs"), med("fast", "wallDurationMs")],
	].map(([metric, base, fast]) => [metric, fmtMs(base), fmtMs(fast), fmtRatio(base && fast ? base / fast : null)]);

	console.log("\nMedians");
	printTable(["metric", "baseline", "fast", "speedup"], medianRows);
	console.log(`\nResults: ${outPath}`);

	if (results.some((result) => statusOf(result) !== "ok")) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
