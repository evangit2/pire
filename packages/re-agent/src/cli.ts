#!/usr/bin/env node
/**
 * pire CLI entry point
 *
 * Usage:
 *   pire                      — Start Pi-framework TUI (default)
 *   pire -ansi                — Start hand-rolled ANSI TUI
 *   pire -cli                 — Start CLI-only mode (plain readline)
 *   pire <path|URL>           — Start with a target loaded
 *   pire -cli <path|URL>      — CLI mode with a target loaded
 *   pire update               — Update to latest from GitHub main
 *   pire update reverse       — Roll back to previous version
 *   pire model                — Interactive model/provider configurator
 *   pire --tools              — List available RE tools
 *   pire --skills             — List available RE skills
 *   pire --probe              — Probe system for installed tools
 *   pire -mcp [--port N]      — Start MCP server (stdio or TCP)
 *   pire --version            — Print version
 */

import { RE_TOOLS, RE_SYSTEM_PROMPT, probeTools } from "./index.js";
import { PireTUI, PireCLI } from "./tui.js";
import { PirePiTUI } from "./pire-pi-tui.js";
import { readdirSync, readFileSync, existsSync } from "node:fs";
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

async function showDiagnose() {
	const { execSync, execFileSync } = await import("node:child_process");
	const { existsSync } = await import("node:fs");

	console.log("pire diagnose — tool detection diagnostics\n");
	console.log("═══════════════════════════════════════════════════");
	console.log("Environment");
	console.log("═══════════════════════════════════════════════════");
	console.log(`  Node.js:    ${process.version}`);
	console.log(`  Platform:   ${process.platform} ${process.arch}`);
	console.log(`  tsx:        ${existsSync("/home/evan/pire/node_modules/.bin/tsx") ? "found (local)" : "not found"}`);
	console.log(`  PATH:       ${process.env.PATH?.split(":").slice(0, 5).join(":")}...`);

	// Python detection
	console.log("\n═══════════════════════════════════════════════════");
	console.log("Python Detection");
	console.log("═══════════════════════════════════════════════════");

	const pyCandidates = process.platform === "darwin"
		? ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "python3"]
		: ["/usr/bin/python3", "python3"];

	let resolvedPython = "python3";
	for (const p of pyCandidates) {
		try {
			execFileSync(p, ["--version"], { stdio: "pipe" });
			const ver = execFileSync(p, ["--version"], { encoding: "utf-8" }).trim();
			console.log(`  ✓ ${p.padEnd(30)} ${ver}`);
			if (resolvedPython === "python3") resolvedPython = p;
		} catch {
			console.log(`  ✗ ${p.padEnd(30)} not found`);
		}
	}
	console.log(`  → Resolved: ${resolvedPython}`);

	// Check which python3 on PATH
	try {
		const pathPy = execSync("which python3", { encoding: "utf-8" }).trim();
		console.log(`  python3 on PATH: ${pathPy}`);
		if (pathPy !== resolvedPython) {
			console.log(`  ⚠ PATH python3 differs from resolved python — modules may not be found`);
		}
	} catch {}

	// Python modules
	console.log("\n═══════════════════════════════════════════════════");
	console.log("Python Modules (checking with " + resolvedPython + ")");
	console.log("═══════════════════════════════════════════════════");
	const pyMods = ["yara", "frida", "capstone", "lief", "angr", "keystone", "unicorn", "volatility3"];
	for (const mod of pyMods) {
		try {
			execFileSync(resolvedPython, ["-c", `import ${mod}`], { stdio: "ignore" });
			console.log(`  ✓ ${mod.padEnd(15)} importable`);
		} catch {
			console.log(`  ✗ ${mod.padEnd(15)} not found — install: pip install --user ${mod === "volatility3" ? "volatility3" : mod}`);
		}
	}

	// CLI tools
	console.log("\n═══════════════════════════════════════════════════");
	console.log("CLI Tools");
	console.log("═══════════════════════════════════════════════════");
	const cliTools: [string, string, string][] = [
		["radare2", "r2", "sudo apt install radare2"],
		["objdump", "objdump", "sudo apt install binutils"],
		["readelf", "readelf", "sudo apt install binutils"],
		["nm", "nm", "sudo apt install binutils"],
		["size", "size", "sudo apt install binutils"],
		["strings", "strings", "sudo apt install binutils"],
		["file", "file", "sudo apt install file"],
		["hexdump", "hexdump", "sudo apt install bsdmainutils"],
		["diff", "diff", "sudo apt install diffutils"],
		["gdb", "gdb", "sudo apt install gdb"],
		["binwalk", "binwalk", "sudo apt install binwalk"],
		["yara", "yara", "sudo apt install yara"],
		["frida", "frida", "pip install --user frida-tools"],
		["jadx", "jadx", "See install.sh jadx section"],
		["ghidra", "ghidra", "See install.sh ghidra section"],
		["monodis", "monodis", "sudo apt install mono-utils"],
	];
	for (const [label, cmd, fixHint] of cliTools) {
		try {
			const path = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim();
			if (path) {
				console.log(`  ✓ ${label.padEnd(15)} ${path}`);
			} else {
				console.log(`  ✗ ${label.padEnd(15)} not on PATH — ${fixHint}`);
			}
		} catch {
			console.log(`  ✗ ${label.padEnd(15)} not found — ${fixHint}`);
		}
	}

	// PATH issues
	console.log("\n═══════════════════════════════════════════════════");
	console.log("PATH Issues");
	console.log("═══════════════════════════════════════════════════");
	const pathDirs = process.env.PATH?.split(":") ?? [];
	const localBin = `${process.env.HOME}/.local/bin`;
	const dotnetTools = `${process.env.HOME}/.dotnet/tools`;
	if (!pathDirs.includes(localBin) && existsSync(localBin)) {
		console.log(`  ⚠ ~/.local/bin exists but is NOT on PATH`);
		console.log(`    Fix: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc`);
	} else if (existsSync(localBin)) {
		console.log(`  ✓ ~/.local/bin on PATH`);
	} else {
		console.log(`  ℹ ~/.local/bin doesn't exist (no pip --user installs yet)`);
	}
	if (!pathDirs.includes(dotnetTools) && existsSync(dotnetTools)) {
		console.log(`  ⚠ ~/.dotnet/tools exists but is NOT on PATH`);
	} else if (existsSync(dotnetTools)) {
		console.log(`  ✓ ~/.dotnet/tools on PATH`);
	}

	// Ghidra MCP server
	console.log("\n═══════════════════════════════════════════════════");
	console.log("Ghidra MCP Server");
	console.log("═══════════════════════════════════════════════════");
	try {
		const resp = await fetch("http://127.0.0.1:8089/");
		console.log(`  ✓ MCP server responding (status ${resp.status})`);
	} catch {
		console.log(`  ✗ MCP server not running on port 8089`);
		console.log(`    Ghidra tools (decompile, functions, etc.) need the MCP bridge running.`);
		console.log(`    Start it with: ghidra + pire's bridge_mcp_ghidra.py`);
	}

	// Summary
	console.log("\n═══════════════════════════════════════════════════");
	console.log("Summary");
	console.log("═══════════════════════════════════════════════════");
	const status = probeTools();
	const available = Object.values(status).filter(Boolean).length;
	const total = Object.keys(status).length;
	console.log(`  ${available}/${total} tools available`);
	if (available < total) {
		console.log(`\n  To fix missing tools, re-run the installer:`);
		console.log(`    curl -fsSL https://raw.githubusercontent.com/evangit2/pire/main/install.sh | sh`);
	}
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
  pire                      Start Pi-framework TUI (default)
  pire -ansi                Start hand-rolled ANSI TUI
  pire -cli                 Start CLI-only mode (plain readline)
  pire <path|URL>           Start with a target loaded
  pire -cli <path|URL>      CLI mode with a target loaded
  pire update               Update to latest version from GitHub
  pire update reverse       Roll back to previous version
  pire model                Interactive model/provider configurator
  pire uninstall            Completely uninstall pire and optionally all RE packages
  pire --tools              List available RE tools
  pire --skills             List available RE skills
  pire --probe              Probe system for installed tools
  pire diagnose             Diagnose why tools aren't detected
  pire -mcp [--port N]      Start MCP server (stdio by default, TCP with --port)
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

// Parse flags
let mode: "pi" | "ansi" | "cli" = "pi";
let positionalArgs: string[] = [];

for (const arg of args) {
	if (arg === "-cli" || arg === "--cli") {
		mode = "cli";
	} else if (arg === "-ansi" || arg === "--ansi") {
		mode = "ansi";
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
	case "diagnose":
	case "--diagnose":
		await showDiagnose();
		break;
	case "--version":
	case "-v":
		showVersion();
		break;
	case "update":
		// Hand off to pire-update.ts
		await import("./pire-update.js");
		break;
	case "model":
		// Hand off to pire-model.ts
		await import("./pire-model.js");
		break;
	case "uninstall":
		// Hand off to pire-uninstall.ts
		await import("./pire-uninstall.js");
		break;
	default:
		if (args[0]?.startsWith("-") && !["-cli", "--cli", "-ansi", "--ansi", "-mcp", "--mcp"].includes(args[0])) {
			console.error(`Unknown option: ${args[0]}`);
			process.exit(1);
		}
		// Start MCP server if -mcp flag is present
		if (args.includes("-mcp") || args.includes("--mcp")) {
			const mcpArgs = args.slice(args.indexOf(args.find(a => a === "-mcp" || a === "--mcp")!) + 1);
			const { startMCPServer } = await import("./mcp-server.js");
			await startMCPServer(mcpArgs);
			break;
		}

		// If first arg is a bare word (not a flag, not a file path, not a URL),
		// it's likely a typo'd subcommand — don't silently launch the TUI.
		if (args[0] && !args[0].startsWith("-") && !/^https?:\/\//.test(args[0]) && !existsSync(args[0])) {
			console.error(`Unknown command: pire ${args[0]}`);
			console.error(`Run 'pire --help' for available commands.`);
			process.exit(1);
		}

		// Start interactive session
		const target = positionalArgs[0];
		if (mode === "cli") {
			const cli = new PireCLI(target);
			cli.start();
		} else if (mode === "ansi") {
			const tui = new PireTUI(target);
			tui.start();
		} else {
			const tui = new PirePiTUI(target);
			tui.start();
		}
		break;
}
