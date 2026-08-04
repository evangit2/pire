/**
 * pire-model.ts — Interactive model configurator
 *
 *   pire model          — Launch interactive provider/model selector
 *
 * Features:
 *   - Saved providers (name, base_url, api_key) stored in ~/.pire/providers.json
 *   - Fetch live model list from provider's /v1/models endpoint
 *   - Select model interactively
 *   - Configure context_length and max_tokens
 *   - Writes active config to ~/.pire/config.yaml
 *   - Add/remove/edit providers
 *
 * Inspired by `hermes model` — clean readline-based interactive UX.
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import chalk from "chalk";

const PIRE_DIR = join(process.env.HOME || "/tmp", ".pire");
const PROVIDERS_FILE = join(PIRE_DIR, "providers.json");
const CONFIG_FILE = join(PIRE_DIR, "config.yaml");

// ─── Types ─────────────────────────────────────────────────────

interface Provider {
	name: string;
	base_url: string;
	api_key: string;
}

interface PireConfig {
	base_url: string;
	api_key: string;
	model: string;
	context_length?: number;
	max_tokens?: number;
}

interface ProvidersDB {
	providers: Provider[];
	active: string | null; // name of active provider
}

// ─── I/O helpers ───────────────────────────────────────────────

function rl(): ReturnType<typeof createInterface> {
	return createInterface({
		input: process.stdin,
		output: process.stdout,
	});
}

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => {
		rl.question(question, (answer) => resolve(answer.trim()));
	});
}

function printHeader(title: string): void {
	console.log();
	console.log(chalk.bold.cyan(`╔${"═".repeat(title.length + 2)}╗`));
	console.log(chalk.bold.cyan(`║ ${title} ║`));
	console.log(chalk.bold.cyan(`╚${"═".repeat(title.length + 2)}╝`));
	console.log();
}

// ─── Config file I/O ───────────────────────────────────────────

function loadProviders(): ProvidersDB {
	if (!existsSync(PROVIDERS_FILE)) {
		return { providers: [], active: null };
	}
	try {
		return JSON.parse(readFileSync(PROVIDERS_FILE, "utf-8"));
	} catch {
		return { providers: [], active: null };
	}
}

function saveProviders(db: ProvidersDB): void {
	if (!existsSync(PIRE_DIR)) mkdirSync(PIRE_DIR, { recursive: true });
	writeFileSync(PROVIDERS_FILE, JSON.stringify(db, null, 2));
}

function loadConfig(): PireConfig | null {
	if (!existsSync(CONFIG_FILE)) return null;
	try {
		const content = readFileSync(CONFIG_FILE, "utf-8");
		const result: Record<string, string> = {};
		for (const rawLine of content.split("\n")) {
			const commentIdx = rawLine.indexOf("#");
			const line = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
			const match = line.match(/^(\w+)\s*:\s*(.+)$/);
			if (!match) continue;
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			result[match[1]] = value;
		}
		if (result.base_url && result.api_key && result.model) {
			return {
				base_url: result.base_url,
				api_key: result.api_key,
				model: result.model,
				context_length: result.context_length ? parseInt(result.context_length) : undefined,
				max_tokens: result.max_tokens ? parseInt(result.max_tokens) : undefined,
			};
		}
	} catch {}
	return null;
}

function saveConfig(config: PireConfig): void {
	if (!existsSync(PIRE_DIR)) mkdirSync(PIRE_DIR, { recursive: true });
	const lines = [
		`base_url: ${config.base_url}`,
		`api_key: ${config.api_key}`,
		`model: ${config.model}`,
	];
	if (config.context_length) lines.push(`context_length: ${config.context_length}`);
	if (config.max_tokens) lines.push(`max_tokens: ${config.max_tokens}`);
	writeFileSync(CONFIG_FILE, lines.join("\n") + "\n");
}

// ─── Fetch models from provider ────────────────────────────────

function fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const url = new URL(baseUrl.replace(/\/$/, "") + "/models");
		const client = url.protocol === "https:" ? https : http;
		const req = client.request(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		}, (res) => {
			if (res.statusCode && res.statusCode >= 400) {
				reject(new Error(`HTTP ${res.statusCode}`));
				return;
			}
			let body = "";
			res.on("data", (chunk) => body += chunk);
			res.on("end", () => {
				try {
					const json = JSON.parse(body);
					const models: string[] = (json.data || json.models || [])
						.map((m: any) => m.id || m.name || m)
						.filter((m: string) => typeof m === "string");
					models.sort();
					resolve(models);
				} catch {
					reject(new Error("Failed to parse /v1/models response"));
				}
			});
		});
		req.on("error", reject);
		req.setTimeout(15000, () => req.destroy(new Error("Timeout")));
		req.end();
	});
}

// ─── Interactive flows ─────────────────────────────────────────

async function selectFromList(rl: ReturnType<typeof createInterface>, title: string, items: string[], allowCustom = false): Promise<string | null> {
	console.log();
	console.log(chalk.bold(title));
	console.log(chalk.dim("─".repeat(40)));
	for (let i = 0; i < items.length; i++) {
		console.log(`  ${chalk.cyan(i + 1)}. ${items[i]}`);
	}
	if (allowCustom) {
		console.log(`  ${chalk.cyan(items.length + 1)}. ${chalk.italic("Enter custom value")}`);
	}
	console.log(`  ${chalk.dim("0.")} Cancel`);
	console.log();

	const answer = await prompt(rl, chalk.bold("Choice> "));
	const num = parseInt(answer);
	if (num === 0 || isNaN(num)) return null;
	if (num >= 1 && num <= items.length) return items[num - 1];
	if (allowCustom && num === items.length + 1) {
		const custom = await prompt(rl, "Enter value: ");
		return custom || null;
	}
	console.log(chalk.red("Invalid choice."));
	return null;
}

async function addProvider(rl: ReturnType<typeof createInterface>): Promise<Provider | null> {
	printHeader("Add Provider");
	console.log(chalk.dim("Examples: OpenAI, OpenRouter, Ollama, VT ARC, custom"));
	const name = await prompt(rl, chalk.bold("Provider name> "));
	if (!name) return null;
	const baseUrl = await prompt(rl, chalk.bold("Base URL> "));
	if (!baseUrl) return null;
	const apiKey = await prompt(rl, chalk.bold("API key> "));
	return { name, base_url: baseUrl, api_key: apiKey || "" };
}

async function editProvider(rl: ReturnType<typeof createInterface>, p: Provider): Promise<Provider> {
	console.log();
	console.log(chalk.dim("Press Enter to keep current value."));
	const name = await prompt(rl, `Name [${p.name}]> `);
	const baseUrl = await prompt(rl, `Base URL [${p.base_url}]> `);
	const apiKey = await prompt(rl, `API key [${p.api_key.slice(0, 8)}...]> `);
	return {
		name: name || p.name,
		base_url: baseUrl || p.base_url,
		api_key: apiKey || p.api_key,
	};
}

// ─── Main interactive loop ─────────────────────────────────────

async function main(): Promise<void> {
	const db = loadProviders();
	const config = loadConfig();

	printHeader("pire model");

	// Show current config
	if (config) {
		console.log(chalk.bold("Current configuration:"));
		console.log(`  ${chalk.dim("Provider URL:")} ${config.base_url}`);
		console.log(`  ${chalk.dim("Model:")}        ${config.model}`);
		if (config.context_length) console.log(`  ${chalk.dim("Context:")}      ${config.context_length} tokens`);
		if (config.max_tokens) console.log(`  ${chalk.dim("Max tokens:")}   ${config.max_tokens}`);
		const activeProv = db.providers.find(p => p.base_url === config.base_url);
		if (activeProv) console.log(`  ${chalk.dim("Provider:")}     ${activeProv.name}`);
	} else {
		console.log(chalk.yellow("No model configured yet."));
	}
	console.log();

	// If no providers, prompt to add one
	if (db.providers.length === 0) {
		console.log(chalk.dim("No saved providers. Let's add one."));
		const rlInst2 = rl();
		const p = await addProvider(rlInst2);
		rlInst2.close();
		if (p) {
			db.providers.push(p);
			db.active = p.name;
			saveProviders(db);
		}
		if (!p) {
			console.log(chalk.red("No provider added."));
			process.exit(1);
		}
	}

	// Main menu
	const rlInst = rl();
	while (true) {
		console.log();
		console.log(chalk.bold("Providers:"));
		console.log(chalk.dim("─".repeat(40)));
		for (let i = 0; i < db.providers.length; i++) {
			const p = db.providers[i];
			const active = db.active === p.name ? chalk.green(" ← active") : "";
			const isCurrent = config?.base_url === p.base_url ? chalk.bold.blue(" (current)") : "";
			console.log(`  ${chalk.cyan(i + 1)}. ${p.name} ${chalk.dim(p.base_url)}${active}${isCurrent}`);
		}
		console.log();
		console.log(`  ${chalk.cyan("a.")} Add provider`);
		console.log(`  ${chalk.cyan("e.")} Edit provider`);
		console.log(`  ${chalk.cyan("r.")} Remove provider`);
		console.log(`  ${chalk.cyan("s.")} Select model (fetch from provider)`);
		console.log(`  ${chalk.cyan("m.")} Manual model entry`);
		console.log(`  ${chalk.cyan("t.")} Set context_length / max_tokens`);
		console.log(`  ${chalk.cyan("q.")} Quit`);
		console.log();

		const choice = await prompt(rlInst, chalk.bold("Choice> "));

		switch (choice.toLowerCase()) {
			case "a": {
				const p = await addProvider(rlInst);
				if (p) {
					db.providers.push(p);
					saveProviders(db);
					console.log(chalk.green(`✓ Added ${p.name}`));
				}
				break;
			}
			case "e": {
				const idxStr = await prompt(rlInst, "Provider number> ");
				const idx = parseInt(idxStr) - 1;
				if (idx >= 0 && idx < db.providers.length) {
					db.providers[idx] = await editProvider(rlInst, db.providers[idx]);
					saveProviders(db);
					console.log(chalk.green("✓ Updated."));
				} else {
					console.log(chalk.red("Invalid."));
				}
				break;
			}
			case "r": {
				const idxStr = await prompt(rlInst, "Provider number to remove> ");
				const idx = parseInt(idxStr) - 1;
				if (idx >= 0 && idx < db.providers.length) {
					const removed = db.providers.splice(idx, 1)[0];
					if (db.active === removed.name) db.active = db.providers[0]?.name ?? null;
					saveProviders(db);
					console.log(chalk.green(`✓ Removed ${removed.name}`));
				} else {
					console.log(chalk.red("Invalid."));
				}
				break;
			}
			case "s": {
				const idxStr = await prompt(rlInst, "Provider number> ");
				const idx = parseInt(idxStr) - 1;
				if (idx < 0 || idx >= db.providers.length) {
					console.log(chalk.red("Invalid."));
					break;
				}
				const p = db.providers[idx];
				console.log(chalk.cyan(`\n→ Fetching models from ${p.name}...`));
				try {
					const models = await fetchModels(p.base_url, p.api_key);
					if (models.length === 0) {
						console.log(chalk.yellow("No models returned. Try manual entry."));
						break;
					}
					const selected = await selectFromList(rlInst, `Models from ${p.name}:`, models);
					if (!selected) break;

					// Save as active config
					const newConfig: PireConfig = {
						base_url: p.base_url,
						api_key: p.api_key,
						model: selected,
						context_length: config?.context_length,
						max_tokens: config?.max_tokens,
					};
					saveConfig(newConfig);
					db.active = p.name;
					saveProviders(db);
					console.log(chalk.green(`\n✓ Model set to: ${selected}`));
					console.log(chalk.dim(`  Provider: ${p.name}`));
					console.log(chalk.dim(`  Config saved to ${CONFIG_FILE}`));
				} catch (e: any) {
					console.error(chalk.red(`✗ Failed to fetch models: ${e.message}`));
					console.log(chalk.dim("  Try manual entry (m) instead."));
				}
				break;
			}
			case "m": {
				const idxStr = await prompt(rlInst, "Provider number> ");
				const idx = parseInt(idxStr) - 1;
				if (idx < 0 || idx >= db.providers.length) {
					console.log(chalk.red("Invalid."));
					break;
				}
				const p = db.providers[idx];
				const model = await prompt(rlInst, "Model name> ");
				if (!model) break;
				const newConfig: PireConfig = {
					base_url: p.base_url,
					api_key: p.api_key,
					model,
					context_length: config?.context_length,
					max_tokens: config?.max_tokens,
				};
				saveConfig(newConfig);
				db.active = p.name;
				saveProviders(db);
				console.log(chalk.green(`\n✓ Model set to: ${model}`));
				console.log(chalk.dim(`  Config saved to ${CONFIG_FILE}`));
				break;
			}
			case "t": {
				const currentConfig = loadConfig();
				if (!currentConfig) {
					console.log(chalk.yellow("Set a model first (s or m)."));
					break;
				}
				const ctxStr = await prompt(rlInst, `Context length [${currentConfig.context_length ?? "default"}]> `);
				const maxStr = await prompt(rlInst, `Max tokens [${currentConfig.max_tokens ?? "default"}]> `);
				if (ctxStr) currentConfig.context_length = parseInt(ctxStr);
				if (maxStr) currentConfig.max_tokens = parseInt(maxStr);
				saveConfig(currentConfig);
				console.log(chalk.green("✓ Token settings saved."));
				break;
			}
			case "q":
			case "quit":
			case "exit":
				rlInst.close();
				process.exit(0);
			default:
				console.log(chalk.red("Invalid choice."));
		}
	}
}

main().catch((e) => {
	console.error(chalk.red(`✗ ${e.message}`));
	process.exit(1);
});
