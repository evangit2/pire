/**
 * pire TUI — Lean RE session dashboard
 *
 * A minimal terminal UI for reverse engineering sessions. Not a full
 * coding agent TUI — just a focused workspace for binary analysis.
 *
 * Layout:
 *  ┌──────────────────────────────────────────────┐
 *  │ pire v0.2.0  │  target: /bin/ls  │  22 tools  │
 *  ├──────────────┬───────────────────────────────┤
 *  │ Tools        │  Output                        │
 *  │ ✓ strings    │                                │
 *  │ ✓ filetype   │  $ filetype /bin/ls            │
 *  │ ✓ r2         │  ELF 64-bit LSB shared object  │
 *  │ ✗ binwalk    │                                │
 *  │ ✓ capstone   │  $ strings /bin/ls | head       │
 *  │              │  /lib64/ld-linux-x86-64.so.2   │
 *  │              │  libc.so.6                     │
 *  ├──────────────┴───────────────────────────────┤
 *  │ > filetype /bin/ls                           │
 *  └──────────────────────────────────────────────┘
 *
 * Commands:
 *  <tab>         — Cycle focus (tools → output → input)
 *  <up>/<down>   — Scroll output
 *  :analyze      — Run guided multi-stage analysis on target
 *  :tools        — List all tools
 *  :probe        — Probe system
 *  :skills       — List skills
 *  :help         — Show commands
 *  :quit         — Exit
 *  <any tool>    — Run a tool: e.g. "strings /bin/ls"
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
	bg: "\x1b[48;5;236m",
	clear: "\x1b[2J\x1b[H",
	clearLine: "\x1b[2K",
	hideCursor: "\x1b[?25l",
	showCursor: "\x1b[?25h",
};

interface OutputLine { text: string; kind: "cmd" | "out" | "err" | "info" | "tool" }

export class PireTUI {
	private rl: readline.Interface;
	private target: string;
	private tools: Record<string, boolean> = {};
	private output: OutputLine[] = [];
	private scrollOffset = 0;
	private input = "";
	private focus: "input" | "tools" | "output" = "input";
	private running = false;

	constructor(target?: string) {
		this.target = target ?? "";
		this.rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false,
		});
	}

	async start() {
		this.running = true;
		this.push("info", `pire v${VERSION} — Reverse Engineering Agent`);
		this.push("info", `Target: ${this.target || "(none)"}`);

		// Probe tools
		this.push("info", "Probing system...");
		this.tools = probeTools();
		const avail = Object.values(this.tools).filter(Boolean).length;
		const total = Object.keys(this.tools).length;
		this.push("info", `${avail}/${total} tools available`);

		if (this.target) {
			this.runQuickAnalysis();
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
		if (this.output.length > 1000) this.output = this.output.slice(-1000);
		this.scrollOffset = 0;
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
			this.push("err", "No target set. Start with: pire <binary>");
			return;
		}
		const target = this.target;

		// Stage 1: Triage
		this.push("info", "═══ Stage 1: Triage ═══");

		// filetype
		try {
			const ft = execSync(`file "${target}"`, { encoding: "utf-8", timeout: 5000 }).trim();
			this.push("tool", `filetype: ${ft}`);
		} catch (e) {
			this.push("err", `filetype failed: ${e}`);
		}

		// strings (filtered for interesting content)
		try {
			const s = execSync(`strings -a -n 6 "${target}" 2>/dev/null | grep -iE '(error|usage|version|secret|password|key|license|flag|http|www|\\.com|\\.org)' | head -30`, { encoding: "utf-8", timeout: 10000 }).trim();
			this.push("tool", `strings (interesting):\n${s || "(none found)"}`);
		} catch {
			try {
				const s = execSync(`strings -a -n 6 "${target}" 2>/dev/null | head -20`, { encoding: "utf-8", timeout: 10000 }).trim();
				this.push("tool", `strings (top 20):\n${s}`);
			} catch {}
		}

		// readelf — imports & sections
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

		// Find function boundaries in .text
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
			this.push("info", "Commands: :analyze :tools :probe :skills :help :quit");
			this.push("info", "Or type a tool name + args, e.g: strings /bin/ls");
			this.push("info", "  disasm_func <path> <addr> — extract a function");
			this.render();
			return;
		}

		if (cmd === ":analyze") {
			await this.runAnalysis();
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
				// Map positional args to tool parameters
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
		const h = process.stdout.rows || 24;
		const lines: string[] = [];

		// Header bar
		const targetStr = this.target ? `target: ${this.target}` : "no target";
		const toolCount = `${RE_TOOLS.length} tools`;
		const headerLeft = `${C.bold}pire v${VERSION}${C.reset}`;
		const headerMid = `${C.dim}${targetStr}${C.reset}`;
		const headerRight = `${C.dim}${toolCount}${C.reset}`;
		const padLen = Math.max(0, w - targetStr.length - toolCount.length - 12);
		lines.push(`${headerLeft}  ${C.gray}${"─".repeat(Math.floor(padLen / 2))}${C.reset}  ${headerMid}  ${C.gray}${"─".repeat(Math.ceil(padLen / 2))}${C.reset}  ${headerRight}`);

		// Tools sidebar (left column, 20 chars wide)
		const toolLines: string[] = [];
		toolLines.push(`${C.bold}${C.dim}Tools${C.reset}`);
		for (const [name, avail] of Object.entries(this.tools)) {
			const mark = avail ? `${C.green}✓${C.reset}` : `${C.gray}✗${C.reset}`;
			const nameStr = avail ? name : `${C.gray}${name}${C.reset}`;
			toolLines.push(` ${mark} ${nameStr}`);
		}

		// Output area (right column)
		const outputLines: string[] = [];
		const outputHeight = h - 4 - Math.max(0, toolLines.length - (h - 4));
		const visibleOutput = this.output.slice(-(outputHeight));

		for (const line of visibleOutput) {
			const prefix = {
				cmd: `${C.cyan}» ${C.reset}`,
				out: `${C.dim}  ${C.reset}`,
				err: `${C.red}! ${C.reset}`,
				info: `${C.blue}• ${C.reset}`,
				tool: `${C.green}⚙ ${C.reset}`,
			}[line.kind];
			const wrapped = this.wrap(prefix + line.text, w - 22);
			outputLines.push(...wrapped);
		}

		// Build body with sidebar
		const bodyHeight = h - 3; // header + input + border
		const leftWidth = 20;
		for (let i = 0; i < bodyHeight; i++) {
			const left = (toolLines[i] ?? "").padEnd(leftWidth).slice(0, leftWidth);
			const right = outputLines[i] ?? "";
			lines.push(`${left}${C.gray}│${C.reset} ${right}`);
		}

		// Input line
		lines.push(`${C.gray}${"─".repeat(w)}${C.reset}`);
		lines.push(`${C.bold}> ${C.reset}${this.input}${C.dim}█${C.reset}`);

		// Render
		process.stdout.write(C.clear);
		process.stdout.write(lines.join("\n"));
		process.stdout.write(`\r`);
	}

	private wrap(text: string, width: number): string[] {
		// Strip ANSI for width calculation but keep for display
		const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
		if (stripped.length <= width) return [text];
		const lines: string[] = [];
		let current = text;
		while (current) {
			const strippedCurrent = current.replace(/\x1b\[[0-9;]*m/g, "");
			if (strippedCurrent.length <= width) { lines.push(current); break; }
			// Find a break point
			let breakAt = width;
			const spaceIdx = strippedCurrent.lastIndexOf(" ", width);
			if (spaceIdx > 0) breakAt = spaceIdx;
			lines.push(current.slice(0, breakAt));
			current = current.slice(breakAt).trimStart();
		}
		return lines;
	}

	stop() {
		this.running = false;
		this.rl.close();
		process.stdout.write(C.showCursor + C.reset);
		process.stdout.write("\n");
		process.exit(0);
	}
}
