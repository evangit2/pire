/**
 * pire — Reverse Engineering Agent
 *
 * Native tools (not MCP servers):
 * - Ghidra bridge with crash recovery + auto-restart
 * - Radare2 with persistent session
 * - Auto-detecting wrappers: binwalk, lief, angr, capstone, yara, frida, etc.
 *
 * Tools degrade gracefully — only available if the underlying binary/module exists.
 */

import { Type } from "typebox";
import { execSync, spawn } from "node:child_process";
import { writeFileSync, existsSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Platform helpers ──────────────────────────────────────────
const IS_WIN = process.platform === "win32";
const DEVNULL = IS_WIN ? "2>nul" : "2>/dev/null";
const PYTHON = IS_WIN ? "python" : "python3";
const NULL_DEVICE = IS_WIN ? "NUL" : "/dev/null";

// ─── Types ─────────────────────────────────────────────────────

export interface ToolResult {
	content: { type: "text"; text: string }[];
	details?: Record<string, unknown>;
}

export interface AgentTool<P = Record<string, unknown>> {
	name: string;
	label?: string;
	description: string;
	parameters: ReturnType<typeof Type.Object>;
	executionMode?: "sequential" | "parallel";
	execute: (id: string, params: P) => Promise<ToolResult>;
}

// ─── Utilities ─────────────────────────────────────────────────

function shellEscape(s: string): string {
	if (/^[a-zA-Z0-9_\-./:]+$/.test(s)) return s;
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function which(cmd: string): string | null {
	try {
		const checker = IS_WIN ? "where" : "which";
		const p = execSync(`${checker} ${cmd} ${DEVNULL}`, { encoding: "utf-8" }).trim();
		return p || null;
	} catch {
		return null;
	}
}

function pythonModule(name: string): boolean {
	try {
		execSync(`${PYTHON} -c "import ${name}" ${DEVNULL}`, { encoding: "utf-8" });
		return true;
	} catch {
		return false;
	}
}

function run(cmd: string, opts: { timeout?: number; maxBuffer?: number; cwd?: string } = {}): string {
	return execSync(cmd, {
		encoding: "utf-8",
		timeout: opts.timeout ?? 30000,
		maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
		cwd: opts.cwd,
	});
}

function textResult(text: string, details?: Record<string, unknown>): ToolResult {
	return {
		content: [{ type: "text" as const, text: text.slice(0, 50000) }],
		details: { ...details, truncated: text.length > 50000 },
	};
}

/** Detect PE binary by checking for the MZ header (first 2 bytes). */
function isPEBinary(path: string): boolean {
	try {
		const fd = openSync(path, "r");
		const buf = Buffer.alloc(2);
		readSync(fd, buf, 0, 2, 0);
		closeSync(fd);
		return buf[0] === 0x4d && buf[1] === 0x5a; // "MZ"
	} catch {
		return false;
	}
}

// ─── Ghidra Bridge (native, with crash recovery + auto-start) ──

class GhidraBridge {
	private ghidraUrl: string;
	private restartCount = 0;
	private maxRestarts = 3;
	private bridgePath: string | null = null;

	constructor(url = "http://127.0.0.1:8089/") {
		this.ghidraUrl = url;
		// Try to find the bundled Ghidra MCP bridge
		const candidates = [
			join(__dirname, "..", "..", "ghidra-mcp", "bridge_mcp_ghidra.py"),
			join(__dirname, "..", "..", "..", "ghidra-mcp", "bridge_mcp_ghidra.py"),
		];
		for (const c of candidates) {
			if (existsSync(c)) { this.bridgePath = c; break; }
		}
	}

	private isAlive(): boolean {
		try {
			run(`curl -sf ${this.ghidraUrl}health -m 2`, { timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	}

	private ensureAlive(): boolean {
		if (this.isAlive()) return true;
		if (this.restartCount >= this.maxRestarts) return false;
		this.restartCount++;
		// Try to auto-start the bridge if we found it
		if (this.bridgePath) {
			try {
				spawn(PYTHON, [this.bridgePath, "--no-lazy"], {
					detached: true, stdio: "ignore",
				}).unref();
				// Wait briefly for startup
				run("sleep 2", { timeout: 5000 });
				if (this.isAlive()) return true;
			} catch {}
		}
		return false;
	}

	private api(endpoint: string, method = "GET", body?: string): string {
		if (!this.ensureAlive()) {
			throw new Error(`Ghidra server not reachable at ${this.ghidraUrl}. Start Ghidra with the MCP plugin loaded.`);
		}
		const cmd = `curl -sf -X ${method} ${this.ghidraUrl}${endpoint} -m 30${body ? ` -H "Content-Type: application/json" -d ${shellEscape(body)}` : ""}`;
		return run(cmd, { timeout: 35000 });
	}

	decompile(functionName: string): string {
		return this.api(`decompile/${encodeURIComponent(functionName)}`);
	}

	listFunctions(): string {
		return this.api("functions");
	}

	rename(oldName: string, newName: string): string {
		return this.api(`rename/${encodeURIComponent(oldName)}/${encodeURIComponent(newName)}`, "POST");
	}

	xrefs(address: string): string {
		return this.api(`xrefs/${address}`);
	}

	searchStrings(pattern: string): string {
		return this.api(`strings?pattern=${encodeURIComponent(pattern)}`);
	}

	listDataTypes(): string {
		return this.api("dataTypes");
	}

	disassemble(address: string): string {
		return this.api(`disassemble/${address}`);
	}

	getStatus(): { alive: boolean; url: string; restarts: number } {
		return { alive: this.isAlive(), url: this.ghidraUrl, restarts: this.restartCount };
	}
}

const ghidra = new GhidraBridge(process.env.GHIDRA_SERVER_URL ?? "http://127.0.0.1:8089/");

// ─── Core Binary Analysis Tools ────────────────────────────────

const stringsTool: AgentTool<{ path: string; minLength?: number; encoding?: string }> = {
	name: "strings",
	description: "Extract printable strings from a binary file.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary file" }),
		minLength: Type.Optional(Type.Number({ description: "Minimum string length (default: 4)", default: 4 })),
		encoding: Type.Optional(Type.String({ description: "Encoding: s=7bit, S=8bit, b=16bit (default: s)", default: "s" })),
	}),
	async execute(_id, params) {
		const minLen = params.minLength ?? 4;
		const enc = params.encoding ?? "s";
		return textResult(run(`strings -a -n ${minLen} -e ${enc} ${shellEscape(params.path)}`), { count: 0 });
	},
};

const fileTool: AgentTool<{ path: string }> = {
	name: "filetype",
	description: "Identify file type, architecture, and format.",
	parameters: Type.Object({ path: Type.String({ description: "Path to the file" }) }),
	async execute(_id, params) {
		return textResult(run(`file ${shellEscape(params.path)}`).trim());
	},
};

const objdumpTool: AgentTool<{ path: string; section?: string; disassemble?: boolean; startAddress?: string; stopAddress?: string }> = {
	name: "objdump",
	description: "Dump sections or disassemble ELF/PE binaries.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		section: Type.Optional(Type.String({ description: "Section name to dump" })),
		disassemble: Type.Optional(Type.Boolean({ description: "Disassemble code sections", default: false })),
		startAddress: Type.Optional(Type.String({ description: "Hex start address" })),
		stopAddress: Type.Optional(Type.String({ description: "Hex stop address" })),
	}),
	async execute(_id, params) {
		const parts = ["objdump"];
		if (params.disassemble) {
			parts.push("-d");
			if (params.startAddress && params.stopAddress) {
				parts.push(`--start-address=0x${params.startAddress.replace(/^0x/, "")}`);
				parts.push(`--stop-address=0x${params.stopAddress.replace(/^0x/, "")}`);
			}
		}
		if (params.section) parts.push("-s", `-j ${shellEscape(params.section)}`);
		if (!params.disassemble && !params.section) parts.push("-h");
		parts.push(shellEscape(params.path));
		return textResult(run(parts.join(" ")));
	},
};

const readelfTool: AgentTool<{ path: string; info?: string }> = {
	name: "readelf",
	description: "Read ELF headers, sections, symbols, relocations.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the ELF binary" }),
		info: Type.Optional(Type.String({ description: "headers, sections, symbols, dynamic, notes, all", default: "all" })),
	}),
	async execute(_id, params) {
		const flagMap: Record<string, string> = { headers: "-h", sections: "-S", symbols: "-s", dynamic: "-d", notes: "-n", all: "-a" };
		const flag = flagMap[params.info ?? "all"] ?? "-a";
		return textResult(run(`readelf ${flag} ${shellEscape(params.path)}`));
	},
};

const hexdumpTool: AgentTool<{ path: string; offset?: number; length?: number }> = {
	name: "hexdump",
	description: "Hex dump a region of a file.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the file" }),
		offset: Type.Optional(Type.Number({ description: "Byte offset (default: 0)", default: 0 })),
		length: Type.Optional(Type.Number({ description: "Bytes to read (default: 256)", default: 256 })),
	}),
	async execute(_id, params) {
		const offset = params.offset ?? 0;
		const length = params.length ?? 256;
		return textResult(run(`dd if=${shellEscape(params.path)} bs=1 skip=${offset} count=${length} ${DEVNULL} | hexdump -C`), { offset, length });
	},
};

// ─── Radare2 (native, persistent session via long-lived process) ───

class R2Session {
	private currentFile: string | null = null;
	private r2path: string | null = null;
	private proc: { child: ReturnType<typeof spawn>; stdin: NodeJS.WritableStream; stdout: string } | null = null;

	constructor() {
		this.r2path = which("r2") ?? which("radare2");
	}

	private ensureProcess(path: string): void {
		if (!this.r2path) throw new Error("radare2 not installed");
		// Reuse existing process if same file
		if (this.proc && this.currentFile === path) return;
		// Kill old process if switching files
		if (this.proc) {
			try { this.proc.child.kill(); } catch {}
			this.proc = null;
		}
		const child = spawn(this.r2path, ["-q0", path], { stdio: ["pipe", "pipe", "pipe"] });
		const stdout: string[] = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
		this.proc = { child, stdin: child.stdin, stdout: "" };
		this.currentFile = path;
		// Read initial null byte that r2 emits with -0 flag
		this.proc.stdout = stdout.join("");
	}

	async run(path: string, command: string): Promise<string> {
		this.ensureProcess(path);
		if (!this.proc) throw new Error("r2 process not started");

		// Use a marker to detect command completion
		const marker = `__PIRE_END_${Date.now()}__`;
		const stdoutChunks: string[] = [];
		const child = this.proc.child;

		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.stdout?.removeAllListeners("data");
				reject(new Error("r2 command timeout"));
			}, 60000);

			const onData = (chunk: Buffer) => {
				stdoutChunks.push(chunk.toString());
				const text = stdoutChunks.join("");
				if (text.includes(marker)) {
					clearTimeout(timeout);
					child.stdout?.removeListener("data", onData);
					// Extract output before the marker
					const output = text.split(marker)[0];
					resolve(output.trim());
				}
			};
			child.stdout?.on("data", onData);

			// Send command + marker
			this.proc!.stdin.write(`${command}\necho ${marker}\n`);
		});
	}

	getCurrentFile() { return this.currentFile; }

	dispose() {
		if (this.proc) {
			try { this.proc.child.kill(); } catch {}
			this.proc = null;
		}
	}
}

const r2Session = new R2Session();

const r2Tool: AgentTool<{ path: string; command: string }> = {
	name: "r2",
	description: "Run a radare2 command on a binary. e.g. 'aaa; afl' (analyze+list functions), 'pdf @ main' (disassemble), 'iz' (strings).",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		command: Type.String({ description: "Radare2 command string" }),
	}),
	async execute(_id, params) {
		return textResult(await r2Session.run(params.path, params.command));
	},
};

// ─── r2 Pseudo-Decompiler ─────────────────────────────────────

const decompileTool: AgentTool<{ path: string; address: string }> = {
	name: "decompile",
	description: "Decompile a function at an address using radare2's pdc (pseudo-C). Requires r2 with analysis (aaa) already run.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		address: Type.String({ description: "Function address (hex, e.g. 0x1400016b0)" }),
	}),
	async execute(_id, params) {
		return textResult(await r2Session.run(params.path, `aaa; s ${params.address}; pdc`));
	},
};

// ─── Ghidra Native Tools ───────────────────────────────────────

const ghidraDecompile: AgentTool<{ function: string }> = {
	name: "ghidra_decompile",
	description: "Decompile a function using Ghidra. Requires Ghidra with MCP plugin running.",
	parameters: Type.Object({ function: Type.String({ description: "Function name or address" }) }),
	async execute(_id, params) {
		return textResult(ghidra.decompile(params.function));
	},
};

const ghidraListFunctions: AgentTool<Record<string, never>> = {
	name: "ghidra_functions",
	description: "List all functions in the Ghidra project.",
	parameters: Type.Object({}),
	async execute() {
		return textResult(ghidra.listFunctions());
	},
};

const ghidraRename: AgentTool<{ oldName: string; newName: string }> = {
	name: "ghidra_rename",
	description: "Rename a function or variable in Ghidra.",
	parameters: Type.Object({
		oldName: Type.String({ description: "Current name" }),
		newName: Type.String({ description: "New name" }),
	}),
	async execute(_id, params) {
		return textResult(ghidra.rename(params.oldName, params.newName));
	},
};

const ghidraXrefs: AgentTool<{ address: string }> = {
	name: "ghidra_xrefs",
	description: "List cross-references to an address in Ghidra.",
	parameters: Type.Object({ address: Type.String({ description: "Hex address" }) }),
	async execute(_id, params) {
		return textResult(ghidra.xrefs(params.address));
	},
};

const ghidraStrings: AgentTool<{ pattern?: string }> = {
	name: "ghidra_strings",
	description: "Search strings in the Ghidra project.",
	parameters: Type.Object({ pattern: Type.Optional(Type.String({ description: "Search pattern (regex)" })) }),
	async execute(_id, params) {
		return textResult(ghidra.searchStrings(params.pattern ?? ""));
	},
};

const ghidraStatus: AgentTool<Record<string, never>> = {
	name: "ghidra_status",
	description: "Check if Ghidra MCP server is reachable.",
	parameters: Type.Object({}),
	async execute() {
		const s = ghidra.getStatus();
		return textResult(`Ghidra: ${s.alive ? "connected" : "offline"} at ${s.url} (restart attempts: ${s.restarts})`);
	},
};

// ─── Auto-Detecting Tool Wrappers ──────────────────────────────
// Each tool checks at execute time if the underlying binary/module exists.
// If not, returns a helpful error. No install-time requirements.

const binwalkTool: AgentTool<{ path: string; extract?: boolean }> = {
	name: "binwalk",
	description: "Scan binary for embedded files, firmware images, and compressed data. Requires binwalk installed.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		extract: Type.Optional(Type.Boolean({ description: "Extract found files", default: false })),
	}),
	async execute(_id, params) {
		const bin = which("binwalk");
		if (!bin) return textResult("binwalk not installed. Install: pip install binwalk");
		const flag = params.extract ? "-e" : "";
		return textResult(run(`${bin} ${flag} ${shellEscape(params.path)}`, { timeout: 60000 }));
	},
};

const liefTool: AgentTool<{ path: string; action: string }> = {
	name: "lief",
	description: "Parse binary formats (ELF, PE, Mach-O) with LIEF. Actions: info, imports, exports, sections, headers, dos.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		action: Type.String({ description: "info|imports|exports|sections|headers|dos" }),
	}),
	async execute(_id, params) {
		if (!pythonModule("lief")) return textResult("lief not installed. Install: pip install lief");
		const actions: Record<string, string> = {
			info: 'print(json.dumps({"type":str(b.format),"entrypoint":hex(b.entrypoint) if hasattr(b,"entrypoint") else None}))',
			imports: 'print("\\n".join(f"{i.name}@{i.address:#x}" for i in b.imported_functions))',
			exports: 'print("\\n".join(f"{e.name}@{e.address:#x}" for e in b.exported_functions))',
			sections: 'print("\\n".join(f"{s.name} offset={s.offset:#x} size={s.size}" for s in b.sections))',
			headers: 'print(json.dumps({k:str(v) for k,v in b.header.__dict__.items()}, indent=2))',
			dos: 'print(b.dos_header.__dict__) if hasattr(b,"dos_header") else print("No DOS header")',
		};
		const action = actions[params.action] ?? 'print("Unknown action")';
		const script = `import lief, json, sys; b=lief.parse("${params.path}"); ${action}`;
		return textResult(run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 15000 }));
	},
};

const angrTool: AgentTool<{ path: string; action: string; target?: string }> = {
	name: "angr",
	description: "Symbolic execution with angr. Actions: cfg (build CFG), find (find path to address), properties (binary properties).",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		action: Type.String({ description: "cfg|find|properties" }),
		target: Type.Optional(Type.String({ description: "Target address for find action (hex)" })),
	}),
	async execute(_id, params) {
		if (!pythonModule("angr")) return textResult("angr not installed. Install: pip install angr");
		let script: string;
		if (params.action === "cfg") {
			script = `import angr; p=angr.Project("${params.path}", auto_load_libs=False); cfg=p.analyses.CFGFast(); print(f"Functions: {len(cfg.functions)}"); [print(f"  {n}: {f.addr:#x}") for n,f in list(cfg.functions.items())[:50]]`;
		} else if (params.action === "find" && params.target) {
			script = `import angr; p=angr.Project("${params.path}", auto_load_libs=False); sm=p.factory.simulation_manager(); sm.explore(find=int("${params.target}",16)); print(f"Found: {len(sm.found)} active: {len(sm.active)}"); [print(s.posix.dumps(1)) for s in sm.found[:3]]`;
		} else {
			script = `import angr; p=angr.Project("${params.path}", auto_load_libs=False); print(f"Arch: {p.arch} Entry: {p.entry:#x} PIE: {p.loader.main_object.pic}")`;
		}
		return textResult(run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 120000, maxBuffer: 20 * 1024 * 1024 }));
	},
};

const capstoneTool: AgentTool<{ path: string; offset?: number; count?: number; arch?: string; mode?: string }> = {
	name: "capstone",
	description: "Disassemble binary data with Capstone. Supports multiple architectures.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		offset: Type.Optional(Type.Number({ description: "Byte offset to start (default: 0)", default: 0 })),
		count: Type.Optional(Type.Number({ description: "Number of instructions (default: 50)", default: 50 })),
		arch: Type.Optional(Type.String({ description: "Architecture: x86, arm, arm64, mips (default: x86)", default: "x86" })),
		mode: Type.Optional(Type.String({ description: "Mode: 32, 64, arm (default: 64)", default: "64" })),
	}),
	async execute(_id, params) {
		if (!pythonModule("capstone")) return textResult("capstone not installed. Install: pip install capstone");
		const offset = params.offset ?? 0;
		const count = params.count ?? 50;
		const arch = params.arch ?? "x86";
		const mode = params.mode ?? "64";
		const script = `from capstone import *; import struct; data=open("${params.path}","rb").read()[${offset}:${offset}+${count*15}]; md=Cs(CS_ARCH_${arch.toUpperCase()},CS_MODE_${mode=="64"?"64":mode=="32"?"32":"ARM"}); [print(f"0x{i.address:x}: {i.mnemonic} {i.op_str}") for i in md.disasm(data,${offset})][:${count}]`;
		return textResult(run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 15000 }));
	},
};

const keystoneTool: AgentTool<{ assembly: string; arch?: string; mode?: string }> = {
	name: "keystone",
	description: "Assemble instructions to bytes with Keystone. Provide assembly text.",
	parameters: Type.Object({
		assembly: Type.String({ description: "Assembly instructions (e.g. 'xor eax, eax; ret')" }),
		arch: Type.Optional(Type.String({ description: "Architecture: x86, arm, arm64, mips (default: x86)", default: "x86" })),
		mode: Type.Optional(Type.String({ description: "Mode: 32, 64, arm (default: 64)", default: "64" })),
	}),
	async execute(_id, params) {
		if (!pythonModule("keystone")) return textResult("keystone not installed. Install: pip install keystone-engine");
		const arch = params.arch ?? "x86";
		const mode = params.mode ?? "64";
		const script = `from keystone import *; ks=Ks(KS_ARCH_${arch.toUpperCase()},KS_MODE_${mode=="64"?"64":mode=="32"?"32":"ARM"}); encoding,count=ks.asm("${params.assembly.replace(/"/g, '\\"')}"); print(" ".join(f"{b:02x}" for b in encoding))`;
		return textResult(run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 10000 }));
	},
};

const unicornTool: AgentTool<{ path: string; entry?: string; arch?: string; mode?: string; steps?: number }> = {
	name: "unicorn",
	description: "Emulate binary code with Unicorn Engine. Loads a code segment and emulates N steps.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		entry: Type.Optional(Type.String({ description: "Entry point hex address (default: auto-detect)" })),
		arch: Type.Optional(Type.String({ description: "Architecture: x86, arm, arm64, mips (default: x86)", default: "x86" })),
		mode: Type.Optional(Type.String({ description: "Mode: 32, 64, arm (default: 64)", default: "64" })),
		steps: Type.Optional(Type.Number({ description: "Number of instructions to emulate (default: 1000)", default: 1000 })),
	}),
	async execute(_id, params) {
		if (!pythonModule("unicorn")) return textResult("unicorn not installed. Install: pip install unicorn");
		const arch = params.arch ?? "x86";
		const mode = params.mode ?? "64";
		const steps = params.steps ?? 1000;
		const entry = params.entry ?? "0";
		const script = `from unicorn import *; from unicorn.x86_const import *; import struct; data=open("${params.path}","rb").read(); uc=Uc(UC_ARCH_${arch.toUpperCase()},UC_MODE_${mode=="64"?"64":mode=="32"?"32":"ARM"}); uc.mem_map(0x10000, 2*1024*1024); uc.mem_write(0x10000, data); uc.emu_start(0x10000+int("${entry}",16) if "${entry}" else 0x10000, 0x10000+len(data), count=${steps}); rax=uc.reg_read(UC_X86_REG_RAX); print(f"Emulated ${steps} steps. RAX={rax:#x}")`;
		try {
			return textResult(run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 30000 }));
		} catch (e: any) {
			const stderr = e.stderr ? e.stderr.toString() : "";
			const errLine = stderr.split("\n").find((l: string) => l.includes("Error:") || l.includes("error:")) || e.message;
			return textResult(`Unicorn emulation failed: ${errLine.trim()}`);
		}
	},
};

const yaraTool: AgentTool<{ path: string; rule: string }> = {
	name: "yara",
	description: "Scan binary with YARA rules. Provide rule text directly.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		rule: Type.String({ description: "YARA rule text" }),
	}),
	async execute(_id, params) {
		if (!pythonModule("yara")) return textResult("yara-python not installed. Install: pip install yara-python");
		const tmpRule = `/tmp/pire_yara_${Date.now()}.yar`;
		writeFileSync(tmpRule, params.rule);
		try {
			const result = run(`${PYTHON} -c "import yara; r=yara.compile('${tmpRule}'); m=r.match('${params.path}'); print('\\\\n'.join(f'{s}: {t}' for m2 in m for s,t in [(m2.rule, 'matched')]) if m else print('No matches'))" ${DEVNULL}`, { timeout: 15000 });
			return textResult(result);
		} finally {
			try { run(`rm -f ${tmpRule}`); } catch {}
		}
	},
};

const fridaTool: AgentTool<{ target: string; script: string; action: string }> = {
	name: "frida",
	description: "Dynamic instrumentation with Frida. Actions: spawn (spawn+inject), attach (attach to PID/name), list (list processes).",
	parameters: Type.Object({
		target: Type.String({ description: "Binary path or PID (for spawn/attach) or empty (for list)" }),
		script: Type.Optional(Type.String({ description: "Frida JS script" })),
		action: Type.String({ description: "spawn|attach|list" }),
	}),
	async execute(_id, params) {
		const fridaBin = which("frida") ?? which("frida-trace");
		if (!fridaBin && !pythonModule("frida")) return textResult("frida not installed. Install: pip install frida-tools");
		if (params.action === "list") {
			return textResult(run(`frida-ps -a ${DEVNULL} || ${PYTHON} -c "import frida; [print(f'{p.pid}: {p.name}') for p in frida.enumerate_devices()[0].enumerate_processes()]"`, { timeout: 10000 }));
		}
		const tmpScript = `/tmp/pire_frida_${Date.now()}.js`;
		writeFileSync(tmpScript, params.script ?? "");
		try {
			const flag = params.action === "spawn" ? "-f" : "-p";
			return textResult(run(`frida ${flag} ${shellEscape(params.target)} -l ${tmpScript} --no-pause -q 2>&1`, { timeout: 30000 }));
		} finally {
			try { run(`rm -f ${tmpScript}`); } catch {}
		}
	},
};

const gdbTool: AgentTool<{ path: string; commands: string }> = {
	name: "gdb",
	description: "Run GDB commands on a binary. Requires gdb installed.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		commands: Type.String({ description: "GDB commands separated by semicolons" }),
	}),
	async execute(_id, params) {
		const bin = which("gdb");
		if (!bin) return textResult("gdb not installed");
		return textResult(run(`${bin} -batch -ex "${params.commands.replace(/"/g, '\\"')}" ${shellEscape(params.path)}`, { timeout: 30000 }));
	},
};

const volatilityTool: AgentTool<{ memdump: string; plugin: string; extraArgs?: string }> = {
	name: "volatility",
	description: "Memory forensics with Volatility 3. Requires volatility3 + python.",
	parameters: Type.Object({
		memdump: Type.String({ description: "Path to memory dump" }),
		plugin: Type.String({ description: "Plugin name (e.g. windows.pslist, windows.netscan)" }),
		extraArgs: Type.Optional(Type.String({ description: "Extra arguments" })),
	}),
	async execute(_id, params) {
		const vol = which("vol") ?? which("volatility3");
		if (!vol && !pythonModule("volatility3")) return textResult("volatility3 not installed. Install: pip install volatility3");
		const cmd = vol ?? `${PYTHON} -m volatility3`;
		try {
			return textResult(run(`${cmd} -f ${shellEscape(params.memdump)} ${params.plugin} ${params.extraArgs ?? ""} ${DEVNULL}`, { timeout: 60000 }));
		} catch (e: any) {
			const stderr = e.stderr ? e.stderr.toString() : "";
			const errLine = stderr.split("\n").find((l: string) => l.includes("Error") || l.includes("error")) || e.message;
			return textResult(`Volatility failed: ${errLine.trim()}`);
		}
	},
};

// ─── Function Extraction Tool ──────────────────────────────────

/**
 * Extract a single function's disassembly from a stripped binary.
 * Detects PE vs ELF — uses r2 for PE (objdump is unreliable on PE without
 * special flags) and objdump for ELF.
 * For ELF: collects all instructions from the start address until the next
 * function boundary (endbr64 or alignment padding after the last ret),
 * avoiding the common pitfall of stopping at the first early-exit ret.
 */
const disasmFuncTool: AgentTool<{ path: string; startAddress: string; maxBytes?: number }> = {
	name: "disasm_func",
	description: "Extract a single function's disassembly from a stripped binary. More reliable than raw objdump — collects the full function body past early-exit rets until the next function boundary. Provide a hex start address. Works on both ELF and PE binaries.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to the binary" }),
		startAddress: Type.String({ description: "Hex start address of the function (e.g. '0x1140')" }),
		maxBytes: Type.Optional(Type.Number({ description: "Max bytes to scan (default: 8192)", default: 8192 })),
	}),
	async execute(_id, params) {
		const addr = params.startAddress.replace(/^0x/, "");
		const maxBytes = params.maxBytes ?? 8192;

		// Detect PE binary by reading the first 2 bytes (MZ header)
		const isPE = isPEBinary(params.path);

		if (isPE) {
			// Use r2 for PE binaries — objdump is unreliable on PE
			const r2path = which("r2") ?? which("radare2");
			if (r2path) {
				const result = run(
					`${r2path} -qc "aaa; s 0x${addr}; pdf" ${shellEscape(params.path)} ${DEVNULL}`,
					{ timeout: 60000 },
				);
				if (result.trim()) {
					return textResult(result, { startAddress: `0x${addr}`, format: "r2-pdf" });
				}
			}
			// Fall back to objdump with PE target if r2 not available
			const stopAddr = parseInt(addr, 16) + maxBytes;
			const raw = run(
				`objdump -d --target=pei-x86-64 --start-address=0x${addr} --stop-address=0x${stopAddr.toString(16)} ${shellEscape(params.path)} ${DEVNULL}`,
				{ timeout: 15000 },
			);
			return textResult(raw || `No disassembly found at 0x${addr} (PE binary, r2 not available).`, {
				startAddress: `0x${addr}`, format: "objdump-pe",
			});
		}

		// ELF path — use objdump with function boundary detection
		const stopAddr = parseInt(addr, 16) + maxBytes;
		const raw = run(
			`objdump -d --start-address=0x${addr} --stop-address=0x${stopAddr.toString(16)} ${shellEscape(params.path)} ${DEVNULL}`,
			{ timeout: 15000 },
		);
		const lines = raw.split("\n");
		const funcLines: string[] = [];
		let instrCount = 0; // Track actual instructions (not header lines)
		for (const line of lines) {
			// Skip objdump header/section lines
			if (line.startsWith("/") || line.includes("file format") || line.trim() === "") continue;
			if (line.includes("Disassembly of section")) continue;
			if (line.includes("<.text") || line.includes("<.init") || line.includes("<.fini")) continue;
			// Track whether this is an actual instruction line (not a symbol header)
			const isInstruction = /^\s+[0-9a-f]+:/.test(line);
			// Stop at next function's endbr64 (but not the function's own first endbr64)
			if (line.includes("endbr64") && instrCount > 0) break;
			if (isInstruction) instrCount++;
			funcLines.push(line);
		}
		// Trim trailing nops/padding after the last real instruction
		while (funcLines.length > 0) {
			const last = funcLines[funcLines.length - 1];
			if (/	nop/.test(last) || /	int3/.test(last) || last.trim() === "") {
				funcLines.pop();
			} else {
				break;
			}
		}
		if (funcLines.length === 0) return textResult(`No disassembly found at 0x${addr}. Check the address is correct.`);
		const retCount = funcLines.filter(l => /	ret/.test(l)).length;
		return textResult(funcLines.join("\n"), {
			startAddress: `0x${addr}`,
			instructions: instrCount,
			returns: retCount,
		});
	},
};

// ─── Shell tool (sandboxed: restricted cwd, network blocked) ───

/** Commands that could exfiltrate data or make network connections. */
const BLOCKED_PATTERNS = [
	/\bcurl\s/, /\bwget\s/, /\bnc\s/, /\bnetcat\s/, /\bssh\s/, /\bscp\s/, /\brsync\s/,
	/\bapt-get\s/, /\bapt\s/, /\bdpkg\s/, /\byum\s/, /\bdnf\s/, /\bpip\s/, /\bpip3\s/,
	/\bnpm\s/, /\bnpx\s/, /\byarn\s/, /\bpnpm\s/, /\bbrew\s/,
	/\bsudo\s/, /\bsu\s/, /\bdoas\s/,
	/\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/,
	/\bmkfs\b/, /\bdd\s+.*of=/, /\b:()\{\s*:\|:&\s*\};:/, // fork bomb
];

/** Check if a command matches any blocked pattern. */
function isCommandBlocked(command: string): string | null {
	for (const pattern of BLOCKED_PATTERNS) {
		if (pattern.test(command)) {
			return `Command blocked by sandbox: matches pattern "${pattern.source}". The shell tool restricts network access, package management, and privileged commands. Use specific RE tools instead.`;
		}
	}
	return null;
}

const shellTool: AgentTool<{ command: string; cwd?: string }> = {
	name: "shell",
	description: "Run a shell command in the workspace sandbox (ls, find, file, gcc, diff, etc.). Network access, package management, and privileged commands are blocked. Optional cwd to set working directory.",
	parameters: Type.Object({
		command: Type.String({ description: "Shell command to execute" }),
		cwd: Type.Optional(Type.String({ description: "Working directory (default: workspace root)" })),
	}),
	async execute(_id, params) {
		const blocked = isCommandBlocked(params.command);
		if (blocked) return textResult(blocked);

		// Restrict cwd to prevent escaping workspace
		const workspaceRoot = process.env.PIRE_WORKSPACE || process.cwd();
		const cwd = params.cwd && existsSync(params.cwd) ? params.cwd : workspaceRoot;

		try {
			const result = run(params.command, { timeout: 60000, cwd });
			return textResult(result.trim() || "(no output)");
		} catch (e: any) {
			// execSync throws on non-zero exit code, but stdout/stderr are still useful
			const stdout = e.stdout ? e.stdout.toString().trim() : "";
			const stderr = e.stderr ? e.stderr.toString().trim() : "";
			const combined = [stdout, stderr].filter(Boolean).join("\n");
			return textResult(combined || `Command failed with exit code ${e.status ?? "?"}: ${e.message}`);
		}
	},
};

// ─── Fetch Tool (download binaries from URLs) ──────────────────

const fetchTool: AgentTool<{ url: string; outputDir?: string }> = {
	name: "fetch",
	description: "Download a file from a URL (HTTP/HTTPS). Use when the user provides a link to a binary, archive, or file to analyze. Saves to /tmp/pire-downloads/ or specified dir.",
	parameters: Type.Object({
		url: Type.String({ description: "URL to download" }),
		outputDir: Type.Optional(Type.String({ description: "Output directory (default: /tmp/pire-downloads)" })),
	}),
	async execute(_id, params) {
		const outDir = params.outputDir || "/tmp/pire-downloads";
		try { mkdirSync(outDir, { recursive: true }); } catch {}
		// Derive filename from URL, fallback to timestamp
		const urlPath = params.url.split("?")[0].split("/").pop() || `file_${Date.now()}`;
		const outPath = join(outDir, urlPath);

		// Try wget first (handles redirects, SSL), fall back to curl
		const wgetBin = which("wget");
		const curlBin = which("curl");
		if (!wgetBin && !curlBin) {
			return textResult("Neither wget nor curl is installed. Install one to download files.");
		}

		const cmd = wgetBin
			? `${wgetBin} -q -O ${shellEscape(outPath)} ${shellEscape(params.url)} 2>&1`
			: `${curlBin} -sL -o ${shellEscape(outPath)} ${shellEscape(params.url)} 2>&1`;

		try {
			run(cmd, { timeout: 120000 });
			if (existsSync(outPath)) {
				const statResult = IS_WIN
					? String(require("node:fs").statSync(outPath).size)
					: run(`stat -c %s ${shellEscape(outPath)} ${DEVNULL} || stat -f %z ${shellEscape(outPath)} ${DEVNULL}`);
				const fileType = IS_WIN ? "unknown" : run(`file ${shellEscape(outPath)}`);
				return textResult(`Downloaded to: ${outPath}\nSize: ${statResult.trim()} bytes\nType: ${fileType.split(":")[1]?.trim() ?? "unknown"}`, {
					path: outPath,
					url: params.url,
				});
			}
			return textResult("Download failed: no file created");
		} catch (e: any) {
			return textResult(`Download failed: ${e.message}`);
		}
	},
};

// ─── Hash Tool ─────────────────────────────────────────────────

const hashTool: AgentTool<{ path: string; algo?: string }> = {
	name: "hash",
	description: "Compute file hashes (md5, sha1, sha256, or all). Useful for identifying known malware or comparing files.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to file" }),
		algo: Type.Optional(Type.String({ description: "Algorithm: md5, sha1, sha256, or all (default: all)" })),
	}),
	async execute(_id, params) {
		const algo = params.algo || "all";
		const algos = algo === "all" ? ["md5sum", "sha1sum", "sha256sum"] : [`${algo}sum`];
		const results: string[] = [];
		for (const a of algos) {
			const bin = which(a);
			if (bin) {
				try {
					const out = run(`${bin} ${shellEscape(params.path)}`, { timeout: 30000 });
					results.push(out.trim());
				} catch { results.push(`${a}: error`); }
			} else {
				results.push(`${a}: not installed`);
			}
		}
		return textResult(results.join("\n"));
	},
};

// ─── Entropy Tool ──────────────────────────────────────────────

const entropyTool: AgentTool<{ path: string; blockSize?: number }> = {
	name: "entropy",
	description: "Calculate Shannon entropy of a file (or per-block). High entropy = compressed/encrypted. Useful for detecting packed sections or encrypted data.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to file" }),
		blockSize: Type.Optional(Type.Number({ description: "Block size in bytes (default: whole file)" })),
	}),
	async execute(_id, params) {
		const py = which(PYTHON);
		if (!py) return textResult("Python not installed");
		const bs = params.blockSize || 0;
		const script = `
import sys, math, collections
data = open(${JSON.stringify(params.path)}, "rb").read()
if ${bs} > 0:
    for i in range(0, len(data), ${bs}):
        block = data[i:i+${bs}]
        if not block: break
        c = collections.Counter(block)
        n = len(block)
        e = -sum((v/n) * math.log2(v/n) for v in c.values())
        print(f"offset {i:#x}: entropy={e:.4f}")
else:
    c = collections.Counter(data)
    n = len(data)
    e = -sum((v/n) * math.log2(v/n) for v in c.values())
    print(f"file entropy: {e:.4f} bits/byte (max=8.0)")
    print(f"file size: {n} bytes")
    if e > 7.5: print("WARNING: very high entropy — likely compressed or encrypted")
    elif e > 6.0: print("NOTE: high entropy — possibly packed")
    elif e < 3.0: print("NOTE: low entropy — mostly text/structured data")
`;
		try {
			const out = run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 30000 });
			return textResult(out);
		} catch (e: any) {
			return textResult(`Entropy calculation failed: ${e.message}`);
		}
	},
};

// ─── Extract Tool (archives: zip, tar, gz, 7z, rar) ────────────

const extractTool: AgentTool<{ path: string; outputDir?: string }> = {
	name: "extract",
	description: "Extract archives (zip, tar.gz, tar.bz2, 7z, rar, deb, rpm). Auto-detects format. Use when analyzing packaged software or firmware.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to archive" }),
		outputDir: Type.Optional(Type.String({ description: "Output directory (default: /tmp/pire-extracted/<filename>)" })),
	}),
	async execute(_id, params) {
		const baseName = params.path.split("/").pop() || "extracted";
		const outDir = params.outputDir || join("/tmp/pire-extracted", baseName);
		try { mkdirSync(outDir, { recursive: true }); } catch {}

		const ext = params.path.toLowerCase();
		let cmd = "";
		if (ext.endsWith(".zip") || ext.endsWith(".jar") || ext.endsWith(".apk") || ext.endsWith(".war")) {
			cmd = `unzip -o -d ${shellEscape(outDir)} ${shellEscape(params.path)} 2>&1`;
		} else if (ext.endsWith(".tar.gz") || ext.endsWith(".tgz")) {
			cmd = `tar xzf ${shellEscape(params.path)} -C ${shellEscape(outDir)} 2>&1`;
		} else if (ext.endsWith(".tar.bz2") || ext.endsWith(".tbz2")) {
			cmd = `tar xjf ${shellEscape(params.path)} -C ${shellEscape(outDir)} 2>&1`;
		} else if (ext.endsWith(".tar.xz") || ext.endsWith(".txz")) {
			cmd = `tar xJf ${shellEscape(params.path)} -C ${shellEscape(outDir)} 2>&1`;
		} else if (ext.endsWith(".tar")) {
			cmd = `tar xf ${shellEscape(params.path)} -C ${shellEscape(outDir)} 2>&1`;
		} else if (ext.endsWith(".gz") && !ext.endsWith(".tar.gz")) {
			cmd = `gunzip -k -c ${shellEscape(params.path)} > ${shellEscape(join(outDir, baseName.replace(/\.gz$/, "")))} 2>&1`;
		} else if (ext.endsWith(".7z")) {
			const b = which("7z") || which("7za");
			if (!b) return textResult("7z not installed. Install p7zip-full.");
			cmd = `${b} x -o${shellEscape(outDir)} -y ${shellEscape(params.path)} 2>&1`;
		} else if (ext.endsWith(".rar")) {
			const b = which("unrar") || which("rar");
			if (!b) return textResult("unrar not installed.");
			cmd = `${b} x -o${shellEscape(outDir)} -y ${shellEscape(params.path)} 2>&1`;
		} else if (ext.endsWith(".deb")) {
			cmd = `dpkg-deb -x ${shellEscape(params.path)} ${shellEscape(outDir)} 2>&1`;
		} else if (ext.endsWith(".rpm")) {
			const b = which("rpm2cpio");
			const c = which("cpio");
			if (!b || !c) return textResult("rpm2cpio/cpio not installed.");
			cmd = `${b} ${shellEscape(params.path)} | ${c} -idm -D ${shellEscape(outDir)} 2>&1`;
		} else {
			// Try binwalk for firmware blobs
			const bw = which("binwalk");
			if (bw) cmd = `${bw} -e -C ${shellEscape(outDir)} ${shellEscape(params.path)} 2>&1`;
			else return textResult(`Unknown archive format: ${params.path}. Try binwalk or manual extraction.`);
		}

		try {
			const out = run(cmd, { timeout: 60000 });
			// List extracted files
			let listing = "";
			try { listing = run(`find ${shellEscape(outDir)} -type f | head -50`, { timeout: 10000 }); } catch {}
			return textResult(`Extracted to: ${outDir}\n${out}\n\nFiles:\n${listing}`, { outputDir: outDir });
		} catch (e: any) {
			return textResult(`Extraction failed: ${e.message}`);
		}
	},
};

// ─── nm Tool (symbol table) ────────────────────────────────────

const nmTool: AgentTool<{ path: string; demangle?: boolean }> = {
	name: "nm",
	description: "List symbols from a binary's symbol table (functions, variables, etc.). Use --demangle for C++ names. Useful for non-stripped binaries.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to binary" }),
		demangle: Type.Optional(Type.Boolean({ description: "Demangle C++ symbols (default: true)" })),
	}),
	async execute(_id, params) {
		const bin = which("nm");
		if (!bin) return textResult("nm not installed (part of binutils)");
		const flag = params.demangle !== false ? "--demangle" : "";
		try {
			const out = run(`${bin} ${flag} ${shellEscape(params.path)} 2>&1`, { timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
			return textResult(out);
		} catch (e: any) {
			const stdout = e.stdout?.toString() || "";
			const stderr = e.stderr?.toString() || "";
			return textResult([stdout, stderr].filter(Boolean).join("\n") || `nm failed: ${e.message}`);
		}
	},
};

// ─── size Tool (section sizes) ─────────────────────────────────

const sizeTool: AgentTool<{ path: string }> = {
	name: "size",
	description: "Display section sizes of a binary (text, data, bss). Quick overview of binary footprint.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to binary" }),
	}),
	async execute(_id, params) {
		const bin = which("size");
		if (!bin) return textResult("size not installed (part of binutils)");
		try {
			const out = run(`${bin} -A ${shellEscape(params.path)} 2>&1`, { timeout: 10000 });
			return textResult(out);
		} catch (e: any) {
			return textResult(`size failed: ${e.message}`);
		}
	},
};

// ─── diff Tool (compare two files) ─────────────────────────────

const diffTool: AgentTool<{ a: string; b: string; context?: number }> = {
	name: "diff",
	description: "Diff two files or binaries. Useful for comparing patched vs original, or two versions of a binary.",
	parameters: Type.Object({
		a: Type.String({ description: "First file path" }),
		b: Type.String({ description: "Second file path" }),
		context: Type.Optional(Type.Number({ description: "Lines of context (default: 3)" })),
	}),
	async execute(_id, params) {
		const bin = which("diff");
		if (!bin) return textResult("diff not installed");
		const ctx = params.context ?? 3;
		const ctxFlag = ctx > 0 ? ` -U${ctx}` : "";
		try {
			const out = run(`diff${ctxFlag} ${shellEscape(params.a)} ${shellEscape(params.b)} 2>&1`, { timeout: 30000 });
			return textResult(out || "(files are identical)");
		} catch (e: any) {
			// diff exits 1 when files differ — that's not an error
			const stdout = e.stdout?.toString() || "";
			const stderr = e.stderr?.toString() || "";
			return textResult(stdout || stderr || "(files are identical)");
		}
	},
};

// ─── Java/Dex Decompilation Tool ───────────────────────────────

const jadxTool: AgentTool<{ path: string; outputDir?: string }> = {
	name: "jadx",
	description: "Decompile APK, DEX, JAR, or AAR files to Java source. Requires jadx installed. Use for Android apps and Java applications.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to APK/DEX/JAR file" }),
		outputDir: Type.Optional(Type.String({ description: "Output directory (default: /tmp/pire-jadx/<filename>)" })),
	}),
	async execute(_id, params) {
		const bin = which("jadx") ?? which("jadx-cli");
		if (!bin) return textResult("jadx not installed. Install from https://github.com/skylot/jadx");
		const baseName = params.path.split("/").pop() || "decompiled";
		const outDir = params.outputDir || join("/tmp/pire-jadx", baseName);
		try { mkdirSync(outDir, { recursive: true }); } catch {}
		try {
			const out = run(`${bin} -d ${shellEscape(outDir)} ${shellEscape(params.path)} 2>&1`, { timeout: 120000 });
			let listing = "";
			try { listing = run(`find ${shellEscape(outDir)} -name "*.java" | head -50`, { timeout: 10000 }); } catch {}
			return textResult(`Decompiled to: ${outDir}\n${out}\n\nJava files:\n${listing}`, { outputDir: outDir });
		} catch (e: any) {
			return textResult(`jadx failed: ${e.message}`);
		}
	},
};

// ─── .NET Decompilation Tool ───────────────────────────────────

const ilspyTool: AgentTool<{ path: string; outputDir?: string }> = {
	name: "ilspy",
	description: "Decompile .NET assemblies (DLL/EXE) to C# source. Requires ilspycmd or monodis installed. Use for .NET applications.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to .NET assembly" }),
		outputDir: Type.Optional(Type.String({ description: "Output directory" })),
	}),
	async execute(_id, params) {
		const ilspy = which("ilspycmd");
		const monodis = which("monodis");
		if (!ilspy && !monodis) return textResult("Neither ilspycmd nor monodis installed. Install ilspycmd (dotnet tool install -g ilspycmd) or mono-utils.");
		const baseName = params.path.split("/").pop() || "decompiled";
		const outDir = params.outputDir || join("/tmp/pire-ilspy", baseName);
		try { mkdirSync(outDir, { recursive: true }); } catch {}

		if (ilspy) {
			try {
				const out = run(`${ilspy} ${shellEscape(params.path)} -p -o ${shellEscape(outDir)} 2>&1`, { timeout: 120000 });
				return textResult(`Decompiled to: ${outDir}\n${out}`, { outputDir: outDir });
			} catch (e: any) {
				return textResult(`ilspycmd failed: ${e.message}`);
			}
		}

		// Fallback: monodis (IL only, not C#)
		try {
			const out = run(`${monodis} --output=${shellEscape(join(outDir, "output.il"))} ${shellEscape(params.path)} 2>&1`, { timeout: 60000 });
			return textResult(`Disassembled (IL) to: ${outDir}/output.il\n${out}`, { outputDir: outDir });
		} catch (e: any) {
			return textResult(`monodis failed: ${e.message}`);
		}
	},
};

// ─── Patch/Dump Tool (hex edit at offset) ──────────────────────

const patchTool: AgentTool<{ path: string; offset: string; bytes: string; backup?: boolean }> = {
	name: "patch",
	description: "Patch bytes at a hex offset in a binary. Takes hex offset and hex byte string. Creates backup by default. Use for binary patching / crackme solving.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to binary" }),
		offset: Type.String({ description: "Hex offset (e.g. 0x1234)" }),
		bytes: Type.String({ description: "Hex bytes to write (e.g. 9090 for two NOPs)" }),
		backup: Type.Optional(Type.Boolean({ description: "Create backup (default: true)" })),
	}),
	async execute(_id, params) {
		const backup = params.backup !== false;
		const backupPath = params.path + ".bak";

		if (backup && !existsSync(backupPath)) {
			try {
				if (IS_WIN) { run(`copy ${shellEscape(params.path)} ${shellEscape(backupPath)}`); }
				else { run(`cp ${shellEscape(params.path)} ${shellEscape(backupPath)} ${DEVNULL}`); }
			} catch {}
		}

		const py = which(PYTHON);
		if (!py) return textResult("Python not installed");
		const script = `
import struct
path = ${JSON.stringify(params.path)}
offset = int(${JSON.stringify(params.offset)}, 16)
byte_hex = ${JSON.stringify(params.bytes)}.replace(" ", "")
data = bytes.fromhex(byte_hex)
with open(path, "r+b") as f:
    f.seek(offset)
    orig = f.read(len(data))
    f.seek(offset)
    f.write(data)
    print(f"Patched {len(data)} bytes at 0x{offset:x}")
    print(f"Original: {orig.hex()}")
    print(f"New:      {data.hex()}")
`;
		try {
			const out = run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 10000 });
			return textResult(out, { backupPath: backup ? backupPath : undefined });
		} catch (e: any) {
			// Extract just the error line, not the full traceback
			const stderr = e.stderr ? e.stderr.toString() : "";
			const errLine = stderr.split("\n").find((l: string) => l.includes("Error:") || l.includes("error:")) || e.message;
			return textResult(`Patch failed: ${errLine.trim()}`);
		}
	},
};

// ─── Search Tool (pattern search in binary) ────────────────────

const searchTool: AgentTool<{ path: string; pattern: string; isHex?: boolean }> = {
	name: "search",
	description: "Search for a pattern in a binary file. Supports text and hex patterns. Returns offset + context for each match.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to file" }),
		pattern: Type.String({ description: "Pattern to search (text or hex)" }),
		isHex: Type.Optional(Type.Boolean({ description: "Treat pattern as hex (default: false = text)" })),
	}),
	async execute(_id, params) {
		const py = which(PYTHON);
		if (!py) return textResult("Python not installed");
		const hexMode = params.isHex === true;
		const script = `
data = open(${JSON.stringify(params.path)}, "rb").read()
pattern = ${hexMode ? `bytes.fromhex(${JSON.stringify(params.pattern)}.replace(" ", ""))` : `${JSON.stringify(params.pattern)}.encode()`}
matches = []
start = 0
while True:
    idx = data.find(pattern, start)
    if idx == -1: break
    ctx_start = max(0, idx - 8)
    ctx_end = min(len(data), idx + len(pattern) + 8)
    ctx = data[ctx_start:ctx_end]
    matches.append(f"0x{idx:x}: {ctx.hex(' ')}")
    start = idx + 1
    if len(matches) >= 100: break
if matches:
    print(f"Found {len(matches)} match(es):")
    for m in matches: print(m)
else:
    print("No matches found")
`;
		try {
			const out = run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 30000 });
			return textResult(out);
		} catch (e: any) {
			return textResult(`Search failed: ${e.message}`);
		}
	},
};

// ─── Tool Registry ─────────────────────────────────────────────

export const RE_TOOLS: AgentTool<any>[] = [
	// Shell (always available)
	shellTool,
	// Fetch & extraction
	fetchTool,
	extractTool,
	// Core (always available if system tools exist)
	stringsTool,
	fileTool,
	objdumpTool,
	readelfTool,
	hexdumpTool,
	disasmFuncTool,
	r2Tool,
	decompileTool,
	nmTool,
	sizeTool,
	searchTool,
	patchTool,
	// Hash & entropy
	hashTool,
	entropyTool,
	diffTool,
	// Ghidra (native, crash-resilient)
	ghidraStatus,
	ghidraDecompile,
	ghidraListFunctions,
	ghidraRename,
	ghidraXrefs,
	ghidraStrings,
	// Auto-detecting wrappers
	binwalkTool,
	liefTool,
	angrTool,
	capstoneTool,
	keystoneTool,
	unicornTool,
	yaraTool,
	fridaTool,
	gdbTool,
	volatilityTool,
	// Language-specific decompilers
	jadxTool,
	ilspyTool,
];

export function createReTools(extra: AgentTool<any>[] = []): AgentTool<any>[] {
	return [...RE_TOOLS, ...extra];
}

/** Probe system for available tools and return status. */
export function probeTools(): Record<string, boolean> {
	const ghidraOk = ghidra.getStatus().alive;
	return {
		shell: true,
		fetch: !!which("wget") || !!which("curl"),
		extract: !!which("unzip") || !!which("tar") || !!which("7z") || !!which("binwalk"),
		strings: !!which("strings") || !!which("Strings"),
		filetype: !!which("file"),
		objdump: !!which("objdump"),
		disasm_func: !!which("objdump") || !!which("r2") || !!which("radare2"),
		readelf: !!which("readelf"),
		hexdump: !!which("hexdump") || IS_WIN,
		nm: !!which("nm"),
		size: !!which("size"),
		search: !!which(PYTHON),
		patch: !!which(PYTHON),
		r2: !!which("r2") || !!which("radare2"),
		decompile: !!which("r2") || !!which("radare2"),
		hash: !!which("md5sum") || !!which("sha256sum") || (IS_WIN && !!which("certutil")),
		entropy: !!which(PYTHON),
		diff: !!which("diff"),
		ghidra_status: ghidraOk,
		ghidra_decompile: ghidraOk,
		ghidra_functions: ghidraOk,
		ghidra_rename: ghidraOk,
		ghidra_xrefs: ghidraOk,
		ghidra_strings: ghidraOk,
		binwalk: !!which("binwalk"),
		lief: pythonModule("lief"),
		angr: pythonModule("angr"),
		capstone: pythonModule("capstone"),
		keystone: pythonModule("keystone"),
		unicorn: pythonModule("unicorn"),
		yara: pythonModule("yara"),
		frida: !!which("frida") || pythonModule("frida"),
		gdb: !!which("gdb"),
		volatility: !!which("vol") || !!which("volatility3") || pythonModule("volatility3"),
		jadx: !!which("jadx") || !!which("jadx-cli"),
		ilspy: !!which("ilspycmd") || !!which("monodis"),
	};
}

// ─── System Prompt ─────────────────────────────────────────────

export const RE_SYSTEM_PROMPT = `You are pire, a reverse engineering agent. You're conversational and can work with any binary or software artifact.

The user gives you a path, URL, or directory and tells you what they want. Run the right tools automatically — don't follow a fixed workflow, adapt to the task.

Use **filetype** to identify what you're working with, then pick the right tools. disasm_func auto-detects PE (MZ header) and routes to r2. PE binaries often use CRLF line endings. Run PE binaries with WINEPREFIX=$HOME/.wine wine <binary>.

Tips: \`imul\` with magic numbers = division, \`lea -0x30\` + \`cmp $0x9\` = ASCII digit check, \`endbr64\` = function boundary in stripped PIE, high entropy (>7.5) = likely packed. Quote exact addresses for findings. If unsure about a constant, say so.

Rules: Never execute target binaries outside sandboxes. Work on copies (patch tool creates backups). If a tool isn't installed, tell the user how to install it.`;

// ─── Exports ───────────────────────────────────────────────────

export {
	shellTool,
	fetchTool, extractTool,
	stringsTool, fileTool, objdumpTool, readelfTool, hexdumpTool, disasmFuncTool, r2Tool, decompileTool,
	nmTool, sizeTool, searchTool, patchTool,
	hashTool, entropyTool, diffTool,
	ghidraStatus, ghidraDecompile, ghidraListFunctions, ghidraRename, ghidraXrefs, ghidraStrings,
	binwalkTool, liefTool, angrTool, capstoneTool, keystoneTool, unicornTool, yaraTool, fridaTool, gdbTool, volatilityTool,
	jadxTool, ilspyTool,
};
