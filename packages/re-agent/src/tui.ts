/**
 * pire TUI — Chat-style RE agent REPL
 *
 * A simple terminal chat interface. No split panes, no binary required.
 * Just start typing — tools, shell commands, or natural language.
 *
 * Layout:
 *  ┌──────────────────────────────────────────────┐
 *  │ pire v0.2.0  │  target: /bin/ls  │  22 tools  │
 *  ├──────────────────────────────────────────────┤
 *  │ • pire v0.2.0 — Reverse Engineering Agent    │
 *  │ • Target: /bin/ls                            │
 *  │ • 18/23 tools available                      │
 *  │ ⚙ filetype → ELF 64-bit LSB shared object    │
 *  │                                              │
 *  │ > strings /bin/ls                            │
 *  │                                              │
 *  └──────────────────────────────────────────────┘
 *
 * Commands:
 *  :load <path>   — Load a target binary
 *  :target        — Show current target
 *  :analyze       — Run guided analysis on target
 *  :tools         — List all tools
 *  :probe         — Probe system
 *  :skills        — List skills
 *  :help          — Show commands
 *  :quit          — Exit
 *  <tool> <args>  — Run a tool: e.g. "strings /bin/ls"
 *  <shell cmd>    — Pass-through to shell
 */

import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RE_TOOLS, RE_SYSTEM_PROMPT, probeTools } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VERSION = "0.2.0";

// ANSI helpers
const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
};

interface OutputLine { text: string; kind: "cmd" | "out" | "err" | "info" | "tool" | "chat" }

export class PireTUI {
	private rl: readline.Interface;
	private target: string;
	private tools: Record<string, boolean> = {};
	private output: OutputLine[] = [];

	constructor(target?: string) {
		this.target = target ?? "";
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});
	}

	async start() {
		this.push("info", `pire v${VERSION} — Reverse Engineering Agent`);
		this.push("info", `Type :help for commands, or just start chatting.`);

		// Probe tools
		this.push("info", "Probing system...");
		this.tools = probeTools();
		const avail = Object.values(this.tools).filter(Boolean).length;
		const total = Object.keys(this.tools).length;
		this.push("info", `${avail}/${total} tools available`);

		if (this.target) {
			this.push("info", `Target: ${this.target}`);
			this.runQuickAnalysis();
		} else {
			this.push("info", `No target loaded. Use :load <path> to load a binary.`);
		}

		this.render();
		this.rl.setPrompt("");
		this.rl.on("line", (line) => this.handleInput(line));
		this.rl.on("close", () => this.stop());
	}

	private push(kind: OutputLine["kind"], text: string) {
		for (const line of text.split("\n")) {
			this.output.push({ text: line, kind });
		}
		if (this.output.length > 5000) this.output = this.output.slice(-5000);
	}

	private runQuickAnalysis() {
		if (!this.target) return;
		try {
			const result = execSync(`file "${this.target}"`, { encoding: "utf-8", timeout: 5000 }).trim();
			this.push("tool", `filetype → ${result}`);
		} catch {}
		try {
			const result = execSync(`strings -a -n 6 "${this.target}" 2>/dev/null | head -20`, { encoding: "utf-8", timeout: 10000 }).trim();
			this.push("tool", `strings (top 20) →\n${result}`);
		} catch {}
	}

	/** Guided multi-stage analysis — runs triage automatically, then suggests next steps. */
	private async runAnalysis() {
		if (!this.target) {
			this.push("err", "No target loaded. Use :load <path> first.");
			return;
		}
		const target = this.target;

		// Stage 1: Triage
		this.push("info", "═══ Stage 1: Triage ═══");

		try {
			const ft = execSync(`file "${target}"`, { encoding: "utf-8", timeout: 5000 }).trim();
			this.push("tool", `filetype: ${ft}`);
		} catch (e) {
			this.push("err", `filetype failed: ${e}`);
		}

		try {
			const s = execSync(`strings -a -n 6 "${target}" 2>/dev/null | grep -iE '(error|usage|version|secret|password|key|license|flag|http|www|\\.com|\\.org)' | head -30`, { encoding: "utf-8", timeout: 10000 }).trim();
			this.push("tool", `strings (interesting):\n${s || "(none found)"}`);
		} catch {
			try {
				const s = execSync(`strings -a -n 6 "${target}" 2>/dev/null | head -20`, { encoding: "utf-8", timeout: 10000 }).trim();
				this.push("tool", `strings (top 20):\n${s}`);
			} catch {}
		}

		try {
			const imports = execSync(`readelf -s "${target}" 2>/dev/null | grep -E 'FUNC|OBJECT' | grep -v UND | head -20`, { encoding: "utf-8", timeout: 5000 }).trim();
			this.push("tool", `symbols:\n${imports || "(stripped)"}`);
		} catch {}
		try {
			const dyn = execSync(`readelf -d "${target}" 2>/dev/null | grep NEEDED`, { encoding: "utf-8", timeout: 5000 }).trim();
			this.push("tool", `linked libs:\n${dyn || "(static)"}`);
		} catch {}

		// Stage 2: Structure
		this.push("info", "═══ Stage 2: Structure ═══");

		try {
			const disasm = execSync(`objdump -d "${target}" 2>/dev/null`, { encoding: "utf-8", timeout: 15000 });
			const funcStarts: string[] = [];
			for (const line of disasm.split("\n")) {
				if (line.includes("endbr64") && /^\s+[0-9a-f]+:/.test(line)) {
					const addr = line.trim().split(":")[0];
					funcStarts.push(addr);
				}
			}
			this.push("tool", `functions found (${funcStarts.length}): ${funcStarts.slice(0, 15).join(", ")}${funcStarts.length > 15 ? " ..." : ""}`);
		} catch (e) {
			this.push("err", `disassembly failed: ${e}`);
		}

		// Stage 3: Suggest next steps
		this.push("info", "═══ Stage 3: Deep Analysis (suggested commands) ═══");
		this.push("info", "  disasm_func " + target + " 0x<addr>   — extract a specific function");
		this.push("info", "  objdump " + target + " -d            — full disassembly");
		this.push("info", "  r2 " + target + " 'aaa; afl'          — radare2 function list");
		this.push("info", "  ghidra_decompile <func>         — decompile (if Ghidra running)");
		this.push("info", "");
		this.push("info", "Tip: Use disasm_func (not raw objdump) for individual functions.");
		this.push("info", "     It correctly handles early-exit rets in stripped binaries.");
	}

	private async handleInput(line: string) {
		const cmd = line.trim();
		if (!cmd) { this.render(); return; }

		if (cmd === ":quit" || cmd === ":q" || cmd === "exit") {
			this.stop();
			return;
		}

		if (cmd === ":help" || cmd === ":h") {
			this.push("info", "Commands:");
			this.push("info", "  :load <path>    Load a target binary");
			this.push("info", "  :target         Show current target");
			this.push("info", "  :analyze        Run guided analysis on target");
			this.push("info", "  :tools          List all tools");
			this.push("info", "  :probe          Re-probe system");
			this.push("info", "  :skills         List skills");
			this.push("info", "  :help           Show this help");
			this.push("info", "  :quit           Exit");
			this.push("info", "");
			this.push("info", "Or type a tool name + args, e.g: strings /bin/ls");
			this.push("info", "  disasm_func <path> <addr> — extract a function");
			this.push("info", "");
			this.push("info", "Anything else is passed to the shell.");
			this.render();
			return;
		}

		if (cmd === ":tools") {
			for (const tool of RE_TOOLS) {
				this.push("info", `  ${tool.name.padEnd(20)} ${tool.description.split(".")[0]}`);
			}
			this.push("info", `${RE_TOOLS.length} tools registered`);
			this.render();
			return;
		}

		if (cmd === ":probe") {
			this.tools = probeTools();
			for (const [name, avail] of Object.entries(this.tools)) {
				this.push("info", `  ${avail ? "✓" : "✗"} ${name}`);
			}
			this.render();
			return;
		}

		if (cmd === ":target") {
			this.push("info", `Target: ${this.target || "(none)"}`);
			this.render();
			return;
		}

		if (cmd.startsWith(":load ")) {
			const path = cmd.slice(6).trim();
			try {
				const ft = execSync(`file "${path}"`, { encoding: "utf-8", timeout: 5000 }).trim();
				this.target = path;
				this.push("info", `Target loaded: ${path}`);
				this.push("tool", `filetype → ${ft}`);
				this.runQuickAnalysis();
			} catch (e) {
				this.push("err", `Failed to load: ${e instanceof Error ? e.message : e}`);
			}
			this.render();
			return;
		}

		if (cmd === ":analyze") {
			await this.runAnalysis();
			this.render();
			return;
		}

		if (cmd === ":skills") {
			try {
				let skillsDir = join(__dirname, "..", "..", "skills");
				try { readdirSync(skillsDir); } catch { skillsDir = join(__dirname, "..", "..", "..", "skills"); }
				const skills = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
				for (const s of skills) {
					try {
						const c = readFileSync(join(skillsDir, s.name, "SKILL.md"), "utf-8");
						const m = c.match(/^description:\s*(.+)$/m);
						this.push("info", `  ${s.name.padEnd(40)} ${m?.[1]?.trim() ?? ""}`);
					} catch {}
				}
				this.push("info", `${skills.length} skills`);
			} catch { this.push("err", "Skills directory not found"); }
			this.render();
			return;
		}

		// Try to match a tool name
		const parts = cmd.split(/\s+/);
		const toolName = parts[0];
		const tool = RE_TOOLS.find(t => t.name === toolName || t.name === toolName.replace(/-/g, "_"));
		if (tool) {
			this.push("cmd", `$ ${cmd}`);
			try {
				const params: Record<string, unknown> = {};
				const schema = tool.parameters;
				const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
				const keys = Object.keys(props);
				const args = parts.slice(1);
				for (let i = 0; i < keys.length && i < args.length; i++) {
					const key = keys[i];
					const prop = props[key] as { type?: string };
					if (prop?.type === "number") params[key] = Number(args[i]);
					else if (prop?.type === "boolean") params[key] = args[i] === "true" || args[i] === "1";
					else params[key] = args[i];
				}
				const result = await tool.execute("tui", params);
				const text = result.content.map((c: { text: string }) => c.text).join("\n");
				this.push("out", text);
			} catch (e) {
				this.push("err", String(e instanceof Error ? e.message : e));
			}
		} else {
			// Pass through to shell
			this.push("cmd", `$ ${cmd}`);
			try {
				const result = execSync(cmd, { encoding: "utf-8", timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
				this.push("out", result.trim() || "(no output)");
			} catch (e) {
				this.push("err", String(e instanceof Error ? e.message : e));
			}
		}
		this.render();
	}

	private render() {
		const w = Math.min(process.stdout.columns || 80, 120);

		// Print any new output lines since last render
		const prefixes: Record<OutputLine["kind"], string> = {
			cmd: `${C.cyan}» ${C.reset}`,
			out: `${C.dim}  ${C.reset}`,
			err: `${C.red}! ${C.reset}`,
			info: `${C.blue}• ${C.reset}`,
			tool: `${C.green}⚙ ${C.reset}`,
			chat: `${C.bold}> ${C.reset}`,
		};

		for (const line of this.output) {
			const prefix = prefixes[line.kind] ?? "";
			process.stdout.write(prefix + line.text + C.reset + "\n");
		}
		// Clear rendered output
		this.output = [];

		// Show prompt
		const targetStr = this.target ? `${C.dim}${this.target}${C.reset}` : "";
		process.stdout.write(`${C.bold}${C.green}pire${C.reset}${targetStr ? ` ${targetStr}` : ""} > `);
	}

	stop() {
		this.running = false;
		this.rl.close();
		process.stdout.write(C.reset + "\n");
		process.exit(0);
	}

	private running = false;
}
