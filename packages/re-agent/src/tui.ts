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
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as https from "node:https";
import * as http from "node:http";
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

// ─── LLM Config ────────────────────────────────────────────────

interface LLMConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

function loadLLMConfig(): LLMConfig | null {
	// Try Hermes config files
	const candidates = [
		process.env.HERMES_CONFIG,
		join(process.env.HOME || "/home/evan", ".hermes/config.yaml"),
		join(process.env.HOME || "/home/evan", ".hermes/profiles/default/config.yaml"),
	];

	for (const path of candidates) {
		if (!path || !existsSync(path)) continue;
		try {
			const content = readFileSync(path, "utf-8");
			// Simple YAML extraction — no dependency needed
			const baseUrl = content.match(/base_url:\s*(.+)/)?.[1]?.trim();
			const apiKey = content.match(/api_key:\s*(.+)/)?.[1]?.trim();
			const model = content.match(/^\s*default:\s*(.+)/m)?.[1]?.trim();

			if (baseUrl && apiKey && model) {
				// Normalize URL — strip trailing slash, ensure /api/v1 path
				let url = baseUrl.replace(/\/$/, "");
				if (!url.includes("/api/v1")) {
					// base_url in hermes config points to /api/v1/ already
				}
				return { baseUrl: url, apiKey, model };
			}
		} catch {}
	}

	// Try environment variables
	if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
		return {
			baseUrl: process.env.OPENAI_BASE_URL,
			apiKey: process.env.OPENAI_API_KEY,
			model: process.env.OPENAI_MODEL || "gpt-4",
		};
	}

	return null;
}

async function chatWithLLM(config: LLMConfig, systemPrompt: string, messages: { role: string; content: string }[]): Promise<string> {
	const url = new URL(config.baseUrl.replace(/\/$/, "") + "/chat/completions");
	const body = JSON.stringify({
		model: config.model,
		messages: [
			{ role: "system", content: systemPrompt },
			...messages,
		],
		max_tokens: 4096,
		stream: false,
	});

	const options: http.RequestOptions = {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${config.apiKey}`,
		},
	};

	const doRequest = (): Promise<string> => new Promise((resolve, reject) => {
		const client = url.protocol === "https:" ? https : http;
		const req = client.request(url, options, (res) => {
			let data = "";
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				if (res.statusCode && res.statusCode >= 500) {
					reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
					return;
				}
				try {
					const json = JSON.parse(data);
					const msg = json.choices?.[0]?.message;
					const content = msg?.content ?? msg?.reasoning;
					if (content) resolve(content);
					else reject(new Error(`No content in response: ${data.slice(0, 200)}`));
				} catch (e) {
					reject(new Error(`Failed to parse LLM response: ${data.slice(0, 200)}`));
				}
			});
		});
		req.on("error", reject);
		req.setTimeout(60000, () => {
			req.destroy(new Error("Request timeout"));
		});
		req.write(body);
		req.end();
	});

	// Retry on transient failures (502, timeout, etc.)
	let lastErr: Error | null = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await doRequest();
		} catch (e) {
			lastErr = e instanceof Error ? e : new Error(String(e));
			if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
		}
	}
	throw lastErr;
}

export class PireTUI {
	private rl: readline.Interface;
	private target: string;
	private tools: Record<string, boolean> = {};
	private output: OutputLine[] = [];
	private llm: LLMConfig | null = null;
	private chatHistory: { role: string; content: string }[] = [];
	private recentToolOutput: string[] = [];  // unflushed context for LLM

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

		// Load LLM config
		this.llm = loadLLMConfig();
		if (this.llm) {
			this.push("info", `LLM: ${this.llm.model}`);
		} else {
			this.push("err", "No LLM config found. Set HERMES_CONFIG or OPENAI_API_KEY/OPENAI_BASE_URL.");
			this.push("info", "Tool/shell commands still work. Chat will not.");
		}

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
		this.rl.on("line", (line) => {
			// Queue input — don't process while busy
			this.inputQueue.push(line);
			this.processQueue();
		});
		this.rl.on("close", () => this.stop());
	}

	private inputQueue: string[] = [];
	private processing = false;

	private async processQueue() {
		if (this.processing) return;
		this.processing = true;
		while (this.inputQueue.length > 0) {
			const line = this.inputQueue.shift()!;
			await this.handleInput(line);
		}
		this.processing = false;
	}

	private push(kind: OutputLine["kind"], text: string) {
		for (const line of text.split("\n")) {
			this.output.push({ text: line, kind });
		}
		// Save tool/output lines for LLM context
		if (kind === "tool" || kind === "out") {
			this.recentToolOutput.push(text);
			if (this.recentToolOutput.length > 50) this.recentToolOutput.shift();
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
		} else if (this.llm) {
			// Chat with the LLM
			this.push("chat", cmd);
			this.render();
			try {
				// Build context: target info + recent tool output + chat history
				let contextMsg = "";
				if (this.target) {
					contextMsg += `Current target binary: ${this.target}\n`;
					if (this.recentToolOutput.length > 0) {
						contextMsg += `Recent tool output:\n${this.recentToolOutput.slice(-15).join("\n")}\n\n`;
					}
				}
				contextMsg += `Available tools: ${Object.entries(this.tools).filter(([,v]) => v).map(([k]) => k).join(", ")}\n`;
				contextMsg += `Available commands: :load, :analyze, :tools, :probe, :skills, or type a tool name directly.`;
				contextMsg += `\nIf you need to run a tool, suggest the exact command. Otherwise answer directly.`;

				const messages = [
					...this.chatHistory,
					{ role: "user", content: `${contextMsg}\n\nUser: ${cmd}` },
				];

				const response = await chatWithLLM(this.llm, RE_SYSTEM_PROMPT, messages);
				this.push("chat", response);

				// Save to history
				this.chatHistory.push({ role: "user", content: cmd });
				this.chatHistory.push({ role: "assistant", content: response });

				// Keep history bounded
				if (this.chatHistory.length > 20) {
					this.chatHistory = this.chatHistory.slice(-20);
				}
			} catch (e) {
				this.push("err", `LLM error: ${e instanceof Error ? e.message : e}`);
			}
		} else {
			// No LLM — pass through to shell as fallback
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
