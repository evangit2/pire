#!/usr/bin/env node
/**
 * pire CLI entry point
 *
 * Usage:
 *   pire                      — Start TUI dashboard (default)
 *   pire -cli                 — Start CLI-only mode (plain readline, no dashboard)
 *   pire <path>               — Start with a target loaded
 *   pire -cli <path>          — CLI mode with a target loaded
 *   pire --tools              — List available RE tools
 *   pire --skills             — List available RE skills
 *   pire --probe              — Probe system for installed tools
 *   pire --version            — Print version
 */

import { RE_TOOLS, RE_SYSTEM_PROMPT, probeTools } from "./index.js";
import { PireTUI, PireCLI } from "./tui.js";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findSkillsDir(): string {
	let dir = __dirname;
	for (let i = 0; i < 5; i++) {
		const candidate = join(dir, "skills");
		try {
			readdirSync(candidate);
			return candidate;
		} catch {}
		dir = dirname(dir);
	}
	return join(__dirname, "..", "..", "..", "skills");
}
const SKILLS_DIR = findSkillsDir();

function listTools() {
	console.log("Available RE Tools:\n");
	for (const tool of RE_TOOLS) {
		console.log(`  ${tool.name.padEnd(20)} ${tool.description.split(".")[0]}`);
	}
	console.log(`\n${RE_TOOLS.length} tools registered`);
}

function listSkills() {
	try {
		const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => {
				const skillPath = join(SKILLS_DIR, d.name, "SKILL.md");
				try {
					const content = readFileSync(skillPath, "utf-8");
					const match = content.match(/^description:\s*(.+)$/m);
					return { name: d.name, description: match?.[1]?.trim() ?? "(no description)" };
				} catch {
					return { name: d.name, description: "(no SKILL.md)" };
				}
			});
		console.log("Available RE Skills:\n");
		for (const skill of skills) {
			console.log(`  ${skill.name.padEnd(40)} ${skill.description}`);
		}
		console.log(`\n${skills.length} skills total`);
	} catch {
		console.log("No skills directory found.");
	}
}

function showProbe() {
	console.log("Probing system for installed tools...\n");
	const status = probeTools();
	const available = Object.entries(status).filter(([, v]) => v);
	const missing = Object.entries(status).filter(([, v]) => !v);
	console.log("Available:");
	for (const [name] of available) console.log(`  ✓ ${name}`);
	console.log("\nNot installed:");
	for (const [name] of missing) console.log(`  ✗ ${name}`);
	console.log(`\n${available.length}/${Object.keys(status).length} tools available`);
}

function showVersion() {
	const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
	console.log(`pire ${pkg.version}`);
}

// ─── Main ──────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args[0] === "--help" || args[0] === "-h") {
	console.log(`pire — Reverse Engineering Agent

Usage:
  pire                      Start TUI dashboard (default)
  pire -cli                 Start CLI-only mode (plain readline)
  pire <path|URL>           Start with a target loaded
  pire -cli <path|URL>      CLI mode with a target loaded
  pire --tools              List available RE tools
  pire --skills             List available RE skills
  pire --probe              Probe system for installed tools
  pire --version            Print version

Chat Commands:
  :load <path|URL>          Load a target into context
  :tools                    List all tools
  :probe                    Re-probe system
  :skills                   List skills
  :save [path]              Save conversation history
  :clear                    Clear output (TUI mode)
  :help                     Show help
  :quit                     Exit

  Just type naturally — I'll run tools as needed.
  e.g. "analyze /bin/ls", "decompile main in ./crackme", "check entropy of firmware.bin"
`);
	process.exit(0);
}

// Check for -cli flag
let useCliMode = false;
let positionalArgs: string[] = [];

for (const arg of args) {
	if (arg === "-cli" || arg === "--cli") {
		useCliMode = true;
	} else if (!arg.startsWith("-")) {
		positionalArgs.push(arg);
	}
}

switch (args[0]) {
	case "--tools":
		listTools();
		break;
	case "--skills":
		listSkills();
		break;
	case "--probe":
		showProbe();
		break;
	case "--version":
	case "-v":
		showVersion();
		break;
	default:
		if (args[0]?.startsWith("-") && args[0] !== "-cli" && args[0] !== "--cli") {
			console.error(`Unknown option: ${args[0]}`);
			process.exit(1);
		}
		// Start interactive session — TUI by default, CLI with -cli flag
		const target = positionalArgs[0];
		if (useCliMode) {
			const cli = new PireCLI(target);
			cli.start();
		} else {
			const tui = new PireTUI(target);
			tui.start();
		}
		break;
}
