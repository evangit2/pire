/**
 * pire-config.ts — Interactive settings configurator
 *
 *   pire config          — Launch interactive settings editor
 *   pire config show     — Print current settings
 *
 * Settings are stored in ~/.pire/settings.json and override defaults.
 * CLI flags (e.g. -loose) override settings.json at runtime.
 *
 * Settings:
 *   max_turns       — Max agent turns per conversation (default: 70)
 *   sandbox         — Shell command sandbox (default: true)
 *   max_output      — Max tool output chars (default: 16000)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";

const PIRE_DIR = join(process.env.HOME || "/tmp", ".pire");
const SETTINGS_FILE = join(PIRE_DIR, "settings.json");

export interface PireSettings {
	max_turns: number;
	sandbox: boolean;
	max_output: number;
}

const DEFAULTS: PireSettings = {
	max_turns: 70,
	sandbox: true,
	max_output: 16000,
};

// ─── I/O ───────────────────────────────────────────────────────

export function loadSettings(): PireSettings {
	if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
	try {
		const raw = readFileSync(SETTINGS_FILE, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			max_turns: typeof parsed.max_turns === "number" ? parsed.max_turns : DEFAULTS.max_turns,
			sandbox: typeof parsed.sandbox === "boolean" ? parsed.sandbox : DEFAULTS.sandbox,
			max_output: typeof parsed.max_output === "number" ? parsed.max_output : DEFAULTS.max_output,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export function saveSettings(settings: PireSettings): void {
	if (!existsSync(PIRE_DIR)) mkdirSync(PIRE_DIR, { recursive: true });
	writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

// ─── CLI: pire config show ─────────────────────────────────────

function showSettings(): void {
	const s = loadSettings();
	console.log(chalk.cyan("pire settings\n"));
	console.log(`  ${chalk.dim("max_turns:")}  ${s.max_turns}`);
	console.log(`  ${chalk.dim("sandbox:")}    ${s.sandbox ? chalk.green("on") : chalk.yellow("off (loose mode)")}`);
	console.log(`  ${chalk.dim("max_output:")} ${s.max_output}`);
	console.log(chalk.dim(`\n  Config file: ${SETTINGS_FILE}`));
}

// ─── CLI: pire config (interactive) ────────────────────────────

function ask(rl: ReturnType<typeof createInterface>, question: string, defaultVal: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(chalk.cyan(`  ${question} `) + chalk.dim(`[${defaultVal}] `), (answer) => {
			resolve(answer.trim() || defaultVal);
		});
	});
}

function askBool(rl: ReturnType<typeof createInterface>, question: string, defaultVal: boolean): Promise<boolean> {
	const def = defaultVal ? "Y/n" : "y/N";
	return new Promise((resolve) => {
		rl.question(chalk.cyan(`  ${question} `) + chalk.dim(`[${def}] `), (answer) => {
			const a = answer.trim().toLowerCase();
			if (!a) return resolve(defaultVal);
			resolve(a === "y" || a === "yes" || a === "true");
		});
	});
}

async function interactiveConfig(): Promise<void> {
	const current = loadSettings();
	console.log(chalk.cyan("\npire settings\n"));
	console.log(chalk.dim("  Press Enter to keep current values.\n"));

	const rl = createInterface({ input: process.stdin, output: process.stdout });

	const maxTurns = parseInt(await ask(rl, "Max turns per conversation:", String(current.max_turns)), 10);
	const sandbox = await askBool(rl, "Sandbox mode (blocks network/package commands)?", current.sandbox);
	const maxOutput = parseInt(await ask(rl, "Max tool output chars:", String(current.max_output)), 10);

	rl.close();

	const settings: PireSettings = {
		max_turns: isNaN(maxTurns) ? current.max_turns : maxTurns,
		sandbox,
		max_output: isNaN(maxOutput) ? current.max_output : maxOutput,
	};

	saveSettings(settings);

	console.log(chalk.green("\n✓ Settings saved"));
	console.log(chalk.dim(`  ${SETTINGS_FILE}\n`));
	console.log("  " + chalk.dim("max_turns:") + `  ${settings.max_turns}`);
	console.log("  " + chalk.dim("sandbox:") + `    ${settings.sandbox ? chalk.green("on") : chalk.yellow("off (loose mode)")}`);
	console.log("  " + chalk.dim("max_output:") + ` ${settings.max_output}`);
	console.log("");
}

// ─── Entry ─────────────────────────────────────────────────────

async function main() {
	const sub = process.argv[process.argv.indexOf("config") + 1];

	if (sub === "show" || sub === "--show") {
		showSettings();
	} else if (sub === "reset" || sub === "--reset") {
		saveSettings({ ...DEFAULTS });
		console.log(chalk.green("✓ Settings reset to defaults"));
		showSettings();
	} else {
		await interactiveConfig();
	}
}

// Only run main() when invoked as `pire config`, not when imported
// for loadSettings/saveSettings by other modules.
const arg0 = process.argv[2];
if (arg0 === "config") {
	main().catch((e) => {
		console.error(chalk.red(`✗ ${e.message}`));
		process.exit(1);
	});
}
