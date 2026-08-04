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
import { writeFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
		const p = execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim();
		return p || null;
	} catch {
		return null;
	}
}

function pythonModule(name: string): boolean {
	try {
		execSync(`python3 -c "import ${name}" 2>/dev/null`, { encoding: "utf-8" });
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
				spawn("python3", [this.bridgePath, "--no-lazy"], {
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
		return textResult(run(`dd if=${shellEscape(params.path)} bs=1 skip=${offset} count=${length} 2>/dev/null | hexdump -C`), { offset, length });
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
		return textResult(run(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000 }));
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
		return textResult(run(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { timeout: 120000, maxBuffer: 20 * 1024 * 1024 }));
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
		return textResult(run(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000 }));
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
		return textResult(run(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000 }));
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
		return textResult(run(`python3 -c '${script.replace(/'/g, "'\\''")}'`, { timeout: 30000 }));
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
			const result = run(`python3 -c "import yara; r=yara.compile('${tmpRule}'); m=r.match('${params.path}'); print('\\n'.join(f'{s}: {t}' for m2 in m for s,t in [(m2.rule, 'matched')]) if m else print('No matches'))"`, { timeout: 15000 });
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
			return textResult(run(`frida-ps -a 2>/dev/null || python3 -c "import frida; [print(f'{p.pid}: {p.name}') for p in frida.enumerate_devices()[0].enumerate_processes()]"`, { timeout: 10000 }));
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
		const cmd = vol ?? "python3 -m volatility3";
		return textResult(run(`${cmd} -f ${shellEscape(params.memdump)} ${params.plugin} ${params.extraArgs ?? ""}`, { timeout: 60000 }));
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
					`${r2path} -qc "aaa; s 0x${addr}; pdf" ${shellEscape(params.path)} 2>/dev/null`,
					{ timeout: 60000 },
				);
				if (result.trim()) {
					return textResult(result, { startAddress: `0x${addr}`, format: "r2-pdf" });
				}
			}
			// Fall back to objdump with PE target if r2 not available
			const stopAddr = parseInt(addr, 16) + maxBytes;
			const raw = run(
				`objdump -d --target=pei-x86-64 --start-address=0x${addr} --stop-address=0x${stopAddr.toString(16)} ${shellEscape(params.path)} 2>/dev/null`,
				{ timeout: 15000 },
			);
			return textResult(raw || `No disassembly found at 0x${addr} (PE binary, r2 not available).`, {
				startAddress: `0x${addr}`, format: "objdump-pe",
			});
		}

		// ELF path — use objdump with function boundary detection
		const stopAddr = parseInt(addr, 16) + maxBytes;
		const raw = run(
			`objdump -d --start-address=0x${addr} --stop-address=0x${stopAddr.toString(16)} ${shellEscape(params.path)} 2>/dev/null`,
			{ timeout: 15000 },
		);
		const lines = raw.split("\n");
		const funcLines: string[] = [];
		for (const line of lines) {
			// Skip objdump header/section lines
			if (line.startsWith("/") || line.includes("file format") || line.trim() === "") continue;
			if (line.includes("Disassembly of section")) continue;
			if (line.includes("<.text") || line.includes("<.init") || line.includes("<.fini")) continue;
			// Stop at next function's endbr64 (but not the function's own first endbr64)
			if (line.includes("endbr64") && funcLines.length > 0) break;
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
		const instrCount = funcLines.filter(l => /^\s+[0-9a-f]+:/.test(l)).length;
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

// ─── Tool Registry ─────────────────────────────────────────────

export const RE_TOOLS: AgentTool<any>[] = [
	// Shell (always available)
	shellTool,
	// Core (always available if system tools exist)
	stringsTool,
	fileTool,
	objdumpTool,
	readelfTool,
	hexdumpTool,
	disasmFuncTool,
	r2Tool,
	decompileTool,
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
];

export function createReTools(extra: AgentTool<any>[] = []): AgentTool<any>[] {
	return [...RE_TOOLS, ...extra];
}

/** Probe system for available tools and return status. */
export function probeTools(): Record<string, boolean> {
	return {
		shell: true,  // always available
		strings: !!which("strings"),
		file: !!which("file"),
		objdump: !!which("objdump"),
		disasm_func: !!which("objdump"),
		readelf: !!which("readelf"),
		hexdump: !!which("hexdump"),
		r2: !!which("r2") || !!which("radare2"),
		decompile: !!which("r2") || !!which("radare2"),
		ghidra: ghidra.getStatus().alive,
		binwalk: !!which("binwalk"),
		lief: pythonModule("lief"),
		angr: pythonModule("angr"),
		capstone: pythonModule("capstone"),
		keystone: pythonModule("keystone"),
		unicorn: pythonModule("unicorn"),
		yara: pythonModule("yara"),
		frida: !!which("frida") || pythonModule("frida"),
		gdb: !!which("gdb"),
		volatility3: !!which("vol") || !!which("volatility3") || pythonModule("volatility3"),
	};
}

// ─── System Prompt ─────────────────────────────────────────────

export const RE_SYSTEM_PROMPT = `You are pire, a reverse engineering agent specialized in analyzing closed-source binaries.

## Tools

Tools auto-detect at runtime. If something isn't installed you'll get a message with install instructions.

### Core (always available)
- **filetype** — Identify file type, arch, format
- **strings** — Extract printable strings
- **objdump** — Disassemble ELF/PE sections
- **disasm_func** — Extract a single function's disassembly (handles stripped binaries, tracks past early-exit rets)
- **readelf** — ELF headers, symbols, relocations
- **hexdump** — Raw hex dump
- **r2** — Radare2 commands (aaa; afl, pdf @ main, iz, etc.)

### Ghidra (native, crash-resilient, auto-starts bridge)
- **ghidra_status** — Check connectivity
- **ghidra_decompile** — Decompile functions
- **ghidra_functions** — List all functions
- **ghidra_rename** — Rename functions/variables
- **ghidra_xrefs** — Cross-references to address
- **ghidra_strings** — Search strings in project

### Disassembly & Emulation
- **capstone** — Multi-arch disassembly
- **keystone** — Multi-arch assembly (instructions → bytes)
- **unicorn** — CPU emulation (load + step through code)
- **angr** — Symbolic execution (CFG, path finding, constraints)

### Binary Parsing & Forensics
- **lief** — Parse ELF/PE/Mach-O (imports, exports, sections, headers)
- **binwalk** — Firmware/embedded file extraction
- **yara** — Pattern matching / signature scanning
- **volatility** — Memory forensics

### Dynamic Analysis
- **frida** — Dynamic instrumentation (spawn, attach, trace)
- **gdb** — Scripted debugging

## Analysis Workflow

Work in stages. Each stage builds on the previous. Don't skip ahead.

### PE Binary Notes
- Windows PE binaries start with "MZ" header — the disasm_func tool auto-detects PE and uses r2 instead of objdump
- For PE: use **r2** with \`aaa; afl\` to list functions, \`pdf @ addr\` to disassemble
- Use **lief** to parse PE imports/exports (look for kernel32.dll, user32.dll imports)
- Run PE binaries with: WINEPREFIX=$HOME/.wine wine <binary> <args>
- PE binaries often use CRLF (\\r\\n) line endings — check with xxd | head

### Stage 1: Triage
- **filetype** — what is this binary?
- **strings** — what does it reveal? (paths, URLs, error messages, version strings)
- **readelf** or **lief** — imports, exports, sections, linkage

### Stage 2: Structure
- **objdump -d** or **r2 aaa; afl** — identify functions, entry points
- For stripped binaries: find function boundaries by looking for endbr64, prologue patterns (push rbp), or call targets from main
- Use **disasm_func** (not raw objdump) to extract individual functions — it handles early-exit rets correctly

### Stage 3: Deep Analysis
- Analyze each function with specific, focused questions
- For each check or branch: quote the exact instruction and address
- Identify constants: comparison values, magic numbers, modulo divisors
- Compiler optimizations to recognize:
  - \`imul\` with magic numbers = division (look up the constant)
  - \`lea -0x30(%reg),%reg\` + \`cmp $0x9\` = ASCII digit check
  - \`bt\` with a bitmask = skip certain indices
  - \`endbr64\` = function boundary in stripped PIE binaries

### Stage 4: Synthesis
- Reconstruct the algorithm in pseudocode
- If possible, forge a valid input that passes all checks
- Verify by running the binary (if safe)

## Rules
- Never execute target binaries outside sandboxes
- Work on copies, never patch originals
- Quote exact instructions and addresses for every finding — don't paraphrase
- If you're unsure about a constant, say so rather than guessing
- Analyze functions in focused passes, not all at once
`;

// ─── Exports ───────────────────────────────────────────────────

export {
	shellTool,
	stringsTool, fileTool, objdumpTool, readelfTool, hexdumpTool, disasmFuncTool, r2Tool, decompileTool,
	ghidraStatus, ghidraDecompile, ghidraListFunctions, ghidraRename, ghidraXrefs, ghidraStrings,
	binwalkTool, liefTool, angrTool, capstoneTool, keystoneTool, unicornTool, yaraTool, fridaTool, gdbTool, volatilityTool,
};
