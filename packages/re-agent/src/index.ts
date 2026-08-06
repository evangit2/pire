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

import { execFileSync, execSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Platform helpers ──────────────────────────────────────────
const IS_WIN = process.platform === "win32";
const DEVNULL = IS_WIN ? "2>nul" : "2>/dev/null";
// Prefer Homebrew Python on macOS (Xcode CLT Python has ancient pip).
// On Linux, prefer /usr/bin/python3 (system Python) over whatever
// python3 resolves to on PATH — the system Python is where pip --user
// installs packages like yara-python, capstone, etc.
function findPython(): string {
	if (IS_WIN) return "python";
	const candidates =
		process.platform === "darwin"
			? ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "python3"]
			: ["/usr/bin/python3", "python3"];
	for (const p of candidates) {
		try {
			execFileSync(p, ["--version"], { stdio: "ignore" });
			return p;
		} catch {}
	}
	return "python3";
}
const PYTHON = findPython();
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
		maxBuffer: opts.maxBuffer ?? 50 * 1024 * 1024,
		cwd: opts.cwd,
	});
}

function textResult(text: string, details?: Record<string, unknown>): ToolResult {
	const limit = 500000;
	const truncated = text.length > limit;
	const out = truncated
		? text.slice(0, limit) +
			"\n\n[... output truncated: showing first " +
			limit +
			" of " +
			text.length +
			" chars ...]"
		: text;
	return {
		content: [{ type: "text" as const, text: out }],
		details: { ...details, truncated, originalLength: text.length },
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
	private ghidraHome: string | null = null;
	private mcpJar: string | null = null;
	private currentTarget: string | null = null;

	constructor(url = "http://127.0.0.1:8089/") {
		this.ghidraUrl = url;
		// Try to find the bundled Ghidra MCP bridge
		const candidates = [
			join(__dirname, "..", "..", "ghidra-mcp", "bridge_mcp_ghidra.py"),
			join(__dirname, "..", "..", "..", "ghidra-mcp", "bridge_mcp_ghidra.py"),
			join(__dirname, "..", "..", "..", "packages", "ghidra-mcp", "bridge_mcp_ghidra.py"),
			"/opt/ghidra-mcp/bridge_mcp_ghidra.py",
		];
		for (const c of candidates) {
			if (existsSync(c)) {
				this.bridgePath = c;
				break;
			}
		}
		// Find Ghidra installation
		try {
			const ghidraDirs = execSync("ls -d /opt/ghidra_* 2>/dev/null", { encoding: "utf-8" })
				.trim()
				.split("\n")
				.filter(Boolean);
			if (ghidraDirs.length > 0) this.ghidraHome = ghidraDirs[0];
		} catch {}
		// Find MCP extension JAR
		if (this.ghidraHome) {
			const version = basename(this.ghidraHome).replace("_PUBLIC", "").replace("ghidra_", "");
			const jarCandidates = [
				join(process.env.HOME || "", ".config", `ghidra_${version}_PUBLIC`, "Extensions", "GhidraMCP", "lib"),
				join(this.ghidraHome, "Extensions", "GhidraMCP", "lib"),
				join(__dirname, "..", "..", "ghidra-mcp", "target"),
				join(__dirname, "..", "..", "..", "packages", "ghidra-mcp", "target"),
				join(__dirname, "..", "..", "..", "ghidra-mcp", "target"),
				"/opt/ghidra-mcp/target",
			];
			for (const dir of jarCandidates) {
				try {
					const jars = execSync(`ls ${dir}/GhidraMCP-*.jar 2>/dev/null`, { encoding: "utf-8" })
						.trim()
						.split("\n")
						.filter(Boolean);
					if (jars.length > 0) {
						this.mcpJar = jars[0];
						break;
					}
				} catch {}
			}
		}
	}

	/** Build the GhidraMCP JAR from source. Auto-detects Ghidra version, patches pom.xml,
	 * installs Ghidra JARs into local Maven repo, and builds with Maven. */
	private buildMcpJar(): void {
		if (!this.ghidraHome) return;
		// Find the ghidra-mcp source directory
		const sourceDirs = [
			join(__dirname, "..", "..", "ghidra-mcp"),
			join(__dirname, "..", "..", "..", "packages", "ghidra-mcp"),
			join(__dirname, "..", "..", "..", "ghidra-mcp"),
		];
		let sourceDir: string | null = null;
		for (const d of sourceDirs) {
			if (existsSync(join(d, "pom.xml"))) {
				sourceDir = d;
				break;
			}
		}
		if (!sourceDir) return;

		// Check for Maven and JDK
		const mvnPath = which("mvn");
		const javacPath = which("javac");
		if (!mvnPath || !javacPath) {
			console.error(
				`[ghidra] Cannot auto-build MCP JAR: ${!mvnPath ? "Maven" : ""}${!mvnPath && !javacPath ? " and " : ""}${!javacPath ? "JDK" : ""} not found.\n` +
				`  Install with: sudo apt install maven default-jdk  (or: brew install maven openjdk)\n` +
				`  Then re-run pire — the JAR will build automatically on first Ghidra tool use.`,
			);
			return;
		}

		// Detect installed Ghidra version and patch pom.xml if needed
		const version = basename(this.ghidraHome).replace("_PUBLIC", "").replace("ghidra_", "");
		const pomPath = join(sourceDir, "pom.xml");
		if (!existsSync(pomPath)) return;
		const pomContent = readFileSync(pomPath, "utf8");
		const pomVersionMatch = pomContent.match(/<ghidra\.version>([^<]+)<\/ghidra\.version>/);
		if (pomVersionMatch && pomVersionMatch[1] !== version) {
			const patched = pomContent.replace(
				/<ghidra\.version>[^<]+<\/ghidra\.version>/,
				`<ghidra.version>${version}</ghidra.version>`,
			);
			writeFileSync(pomPath, patched);
		}

		// Install Ghidra JARs into local Maven repo (idempotent — skips if already there)
		try {
			run(`bash ${join(sourceDir, "ghidra-mcp-setup.sh")} --setup-deps --ghidra-path ${this.ghidraHome} 2>&1`, {
				timeout: 120000,
			});
		} catch {
			// setup-deps may fail if already installed — that's fine
		}

		// Build the JAR
		try {
			run(`cd ${sourceDir} && ${mvnPath} clean package assembly:single -DskipTests -q 2>&1`, {
				timeout: 300000,
			});
		} catch {
			return;
		}

		// Find the built JAR
		const targetDir = join(sourceDir, "target");
		if (!existsSync(targetDir)) return;
		try {
			const jars = execSync(`ls ${targetDir}/GhidraMCP-*.jar 2>/dev/null`, { encoding: "utf8" })
				.trim()
				.split("\n")
				.filter(Boolean);
			if (jars.length > 0) {
				this.mcpJar = jars[0];
			}
		} catch {}
	}

	private isAlive(): boolean {
		try {
			run(`curl -sf ${this.ghidraUrl}health -m 2`, { timeout: 5000 });
			return true;
		} catch {
			return false;
		}
	}

	/** Start the Ghidra headless MCP server with a target binary loaded.
	 * Two-phase approach:
	 * 1. Use Ghidra's analyzeHeadless to import + analyze the binary into a project
	 * 2. Start the MCP server pointing to that project + program
	 */
	startHeadless(targetPath: string): boolean {
		if (this.isAlive() && this.isProgramLoaded()) return true;
		if (!this.ghidraHome) {
			throw new Error("Ghidra installation not found. Install Ghidra or set GHIDRA_HOME.");
		}
		if (!this.mcpJar) {
			this.buildMcpJar();
		}
		if (!this.mcpJar) {
			throw new Error(
				"GhidraMCP extension JAR not found and auto-build failed. Ensure Maven and JDK are installed.",
			);
		}
		if (!existsSync(targetPath)) {
			throw new Error(`Target binary not found: ${targetPath}`);
		}

		this.currentTarget = targetPath;
		const projectDir = join(process.env.HOME || "/tmp", ".pire", "ghidra-projects");
		mkdirSync(projectDir, { recursive: true });
		const projectName = "pire_analysis";
		const programName = basename(targetPath);
		const projectPath = join(projectDir, projectName);
		const classpath = this.buildClasspath();
		const logFile = "/tmp/pire-ghidra-mcp.log";
		const analyzeLog = "/tmp/pire-ghidra-analyze.log";

		// Kill any stale Ghidra MCP server on port 8089
		try {
			run("fuser -k 8089/tcp 2>/dev/null; sleep 2", { timeout: 15000 });
		} catch {}

		// Clean up stale lock files
		const lockPath = projectPath + ".lock";
		const lockTildePath = projectPath + ".lock~";
		try {
			if (existsSync(lockPath)) unlinkSync(lockPath);
			if (existsSync(lockTildePath)) unlinkSync(lockTildePath);
		} catch {}

		// Phase 1: Import + analyze binary into Ghidra project using analyzeHeadless
		// Re-import if project doesn't exist OR .rep directory is missing
		const gprPath = projectPath + ".gpr";
		const repPath = projectPath + ".rep";
		const projectExists = existsSync(gprPath) && existsSync(repPath);
		if (!projectExists) {
			// Delete any partial/corrupt project files
			try {
				if (existsSync(gprPath)) unlinkSync(gprPath);
				if (existsSync(repPath)) rmSync(repPath, { recursive: true, force: true });
			} catch {}
			const analyzeScript = [
				"#!/bin/bash",
				`export GHIDRA_HOME=${this.ghidraHome}`,
				`${this.ghidraHome}/support/analyzeHeadless \\`,
				`    ${projectDir} ${projectName} \\`,
				`    -import ${shellEscape(targetPath)} \\`,
				`    -overwrite \\`,
				`    > ${analyzeLog} 2>&1`,
				"",
			].join("\n");
			const analyzeScriptPath = "/tmp/pire-analyze-ghidra.sh";
			writeFileSync(analyzeScriptPath, analyzeScript, { mode: 0o755 });
			try {
				run(`bash ${analyzeScriptPath}`, { timeout: 300000 });
			} catch {
				// analyzeHeadless may return non-zero even on success
			}
			// Verify the project was actually created
			const repExists = existsSync(repPath);
			if (!repExists) {
				const logContent = (() => { try { return readFileSync(analyzeLog, "utf-8").slice(-500); } catch { return "(no log)"; } })();
				throw new Error(`Ghidra analyzeHeadless failed to create project. Log: ${logContent}`);
			}
		}

		// Phase 2: Start MCP server with the project + program loaded
		if (this.isAlive() && this.isProgramLoaded()) return true;

		const script = [
			"#!/bin/bash",
			`export GHIDRA_HOME=${this.ghidraHome}`,
			`java -Xmx4g -XX:+UseG1GC \\`,
			`    -Dghidra.home=${this.ghidraHome} -Dapplication.name=GhidraMCP \\`,
			`    -classpath "${classpath}" \\`,
			`    com.xebyte.headless.GhidraMCPHeadlessServer \\`,
			`    --port 8089 --bind 127.0.0.1 \\`,
			`    --project ${shellEscape(gprPath)} \\`,
			`    --program ${shellEscape("/" + programName)} \\`,
			`    > ${logFile} 2>&1`,
			"",
		].join("\n");
		const scriptPath = "/tmp/pire-start-ghidra.sh";
		writeFileSync(scriptPath, script, { mode: 0o755 });

		spawn("bash", [scriptPath], {
			detached: true,
			stdio: "ignore",
		}).unref();

		// Wait for startup (Ghidra JVM takes ~15-20s)
		for (let i = 0; i < 30; i++) {
			run("sleep 1", { timeout: 5000 });
			if (this.isAlive() && this.isProgramLoaded()) {
				this.restartCount = 0; // Reset on success
				return true;
			}
		}
		return false;
	}

	private buildClasspath(): string {
		if (!this.ghidraHome || !this.mcpJar) return "";
		const jars: string[] = [this.mcpJar];
		try {
			const frameworkJars = execSync(`ls ${this.ghidraHome}/Ghidra/Framework/*/lib/*.jar 2>/dev/null`, {
				encoding: "utf-8",
			})
				.trim()
				.split("\n")
				.filter(Boolean);
			const featureJars = execSync(`ls ${this.ghidraHome}/Ghidra/Features/*/lib/*.jar 2>/dev/null`, {
				encoding: "utf-8",
			})
				.trim()
				.split("\n")
				.filter(Boolean);
			const processorJars = execSync(`ls ${this.ghidraHome}/Ghidra/Processors/*/lib/*.jar 2>/dev/null`, {
				encoding: "utf-8",
			})
				.trim()
				.split("\n")
				.filter(Boolean);
			jars.push(...frameworkJars, ...featureJars, ...processorJars);
		} catch {}
		return jars.join(":");
	}

	private ensureAlive(): boolean {
		// Case 1: Server alive AND program loaded (or no target needed) → all good
		if (this.isAlive() && (!this.currentTarget || this.isProgramLoaded())) return true;

		// Case 2: Server alive but program NOT loaded → kill it so we can restart clean
		if (this.isAlive() && this.currentTarget && !this.isProgramLoaded()) {
			try { run("fuser -k 8089/tcp 2>/dev/null; sleep 2", { timeout: 15000 }); } catch {}
		}

		if (this.restartCount >= this.maxRestarts) {
			// Last resort: kill any stale server and reset counter for one more try
			try { run("fuser -k 8089/tcp 2>/dev/null; sleep 2", { timeout: 15000 }); } catch {}
			this.restartCount = 0;
		}
		this.restartCount++;
		// If we have a target loaded, try starting the headless server
		// (which also imports+analyzes the binary via analyzeHeadless)
		if (this.currentTarget) {
			try {
				if (this.startHeadless(this.currentTarget)) return true;
			} catch (e) {
				// If startHeadless threw (e.g. analyzeHeadless failed), log it
				// but don't crash the agent — Ghidra tools will report the error
			}
		}
		return false;
	}

	/** Check if the Ghidra server has a program loaded. */
	private isProgramLoaded(): boolean {
		try {
			const resp = run(`curl -sf ${this.ghidraUrl}health -m 2`, { timeout: 5000 });
			return resp.includes('"program_loaded": true') || resp.includes('"program_loaded":true');
		} catch {
			return false;
		}
	}

	private api(endpoint: string, method = "GET", body?: string): string {
		if (!this.ensureAlive()) {
			throw new Error(`Ghidra server not reachable at ${this.ghidraUrl}. Start Ghidra with the MCP plugin loaded.`);
		}
		const cmd = `curl -sf -X ${method} ${this.ghidraUrl}${endpoint} -m 30${body ? ` -H "Content-Type: application/json" -d ${shellEscape(body)}` : ""}`;
		return run(cmd, { timeout: 35000 });
	}

	decompile(functionName: string): string {
		// If it looks like a hex address (0x...) or a plain hex number, send as address
		// Otherwise send as name (e.g. "entry", "FUN_140001000", "main")
		if (/^(0x)?[0-9a-fA-F]+$/.test(functionName)) {
			const addr = functionName.startsWith("0x") ? functionName : `0x${functionName}`;
			return this.api(`decompile_function?address=${encodeURIComponent(addr)}`);
		}
		return this.api(`decompile_function?name=${encodeURIComponent(functionName)}`);
	}

	listFunctions(): string {
		return this.api("list_functions");
	}

	rename(oldName: string, newName: string): string {
		return this.api("rename_function", "POST", JSON.stringify({ old_name: oldName, new_name: newName }));
	}

	xrefs(address: string): string {
		return this.api(`get_xrefs_to?address=${encodeURIComponent(address)}`);
	}

	searchStrings(pattern: string): string {
		return this.api(`list_strings?filter=${encodeURIComponent(pattern)}`);
	}

	listDataTypes(): string {
		return this.api("list_data_types");
	}

	disassemble(address: string): string {
		return this.api(`disassemble_function?address=${encodeURIComponent(address)}`);
	}

	/** Check if the headless server can be auto-started (JAR + Ghidra installed). */
	canAutoStart(): boolean {
		if (!this.ghidraHome) return false;
		if (!this.mcpJar) this.buildMcpJar();
		return !!this.ghidraHome && !!this.mcpJar;
	}

	/** Set the target binary path for auto-start. */
	setTarget(path: string): void {
		this.currentTarget = path;
	}

	getStatus(): { alive: boolean; url: string; restarts: number } {
		return { alive: this.isAlive(), url: this.ghidraUrl, restarts: this.restartCount };
	}
}

const ghidra = new GhidraBridge(process.env.GHIDRA_SERVER_URL ?? "http://127.0.0.1:8089/");

/** Set the target binary for Ghidra auto-start. Called when :load is used. */
export function setGhidraTarget(path: string): void {
	ghidra.setTarget(path);
}

// ─── Core Binary Analysis Tools ────────────────────────────────

const stringsTool: AgentTool<{ path: string; minLength?: number; encoding?: string }> = {
	name: "strings",
	description: "Extract strings from a binary.",
	parameters: Type.Object({
		path: Type.String(),
		minLength: Type.Optional(Type.Number({ default: 4 })),
		encoding: Type.Optional(Type.String({ default: "s" })),
	}),
	async execute(_id, params) {
		const minLen = params.minLength ?? 4;
		const enc = params.encoding ?? "s";
		return textResult(run(`strings -a -n ${minLen} -e ${enc} ${shellEscape(params.path)}`), { count: 0 });
	},
};

const fileTool: AgentTool<{ path: string }> = {
	name: "filetype",
	description: "Identify file type and architecture.",
	parameters: Type.Object({ path: Type.String() }),
	async execute(_id, params) {
		return textResult(run(`file ${shellEscape(params.path)}`).trim());
	},
};

const objdumpTool: AgentTool<{
	path: string;
	section?: string;
	disassemble?: boolean;
	startAddress?: string;
	stopAddress?: string;
}> = {
	name: "objdump",
	description: "objdump: dump sections or disassemble.",
	parameters: Type.Object({
		path: Type.String(),
		section: Type.Optional(Type.String()),
		disassemble: Type.Optional(Type.Boolean({ default: false })),
		startAddress: Type.Optional(Type.String()),
		stopAddress: Type.Optional(Type.String()),
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
		return textResult(run(parts.join(" "), { maxBuffer: 100 * 1024 * 1024, timeout: 60000 }));
	},
};

const readelfTool: AgentTool<{ path: string; info?: string }> = {
	name: "readelf",
	description:
		"readelf: ELF headers, sections, symbols, segments. Use info=headers (-h), sections (-S), symbols (-s), segments (-l), dynamic (-d), notes (-n). Default: headers. Avoid 'all' — it produces massive output.",
	parameters: Type.Object({
		path: Type.String(),
		info: Type.Optional(Type.String({ default: "headers" })),
	}),
	async execute(_id, params) {
		const flagMap: Record<string, string> = {
			headers: "-h",
			sections: "-S",
			symbols: "-s",
			segments: "-l",
			dynamic: "-d",
			notes: "-n",
			all: "-a",
		};
		const flag = flagMap[params.info ?? "headers"] ?? "-h";
		return textResult(run(`readelf ${flag} ${shellEscape(params.path)}`));
	},
};

const hexdumpTool: AgentTool<{ path: string; offset?: number; length?: number }> = {
	name: "hexdump",
	description: "Hex dump a file region.",
	parameters: Type.Object({
		path: Type.String(),
		offset: Type.Optional(Type.Number({ default: 0 })),
		length: Type.Optional(Type.Number({ default: 256 })),
	}),
	async execute(_id, params) {
		const offset = params.offset ?? 0;
		const length = params.length ?? 256;
		return textResult(
			run(`dd if=${shellEscape(params.path)} bs=1 skip=${offset} count=${length} ${DEVNULL} | hexdump -C`),
			{ offset, length },
		);
	},
};

// ─── Radare2 (native, persistent session via long-lived process) ───

class R2Session {
	private currentFile: string | null = null;
	private r2path: string | null = null;
	private proc: { child: ReturnType<typeof spawn>; stdin: NodeJS.WritableStream; stdout: string } | null = null;
	private analyzedFiles: Set<string> = new Set();

	constructor() {
		this.r2path = which("r2") ?? which("radare2");
	}

	isAnalyzed(path: string): boolean {
		return this.analyzedFiles.has(path);
	}

	private ensureProcess(path: string): void {
		if (!this.r2path) throw new Error("radare2 not installed");
		// Reuse existing process if same file
		if (this.proc && this.currentFile === path) return;
		// Kill old process if switching files
		if (this.proc) {
			try {
				this.proc.child.kill();
			} catch {}
			this.proc = null;
		}
		// -q0: quiet mode + emit null byte on startup (so we know it's ready)
		const child = spawn(this.r2path, ["-q0", path], { stdio: ["pipe", "pipe", "pipe"] });
		this.proc = { child, stdin: child.stdin, stdout: "" };
		this.currentFile = path;
		// Don't attach a persistent data listener here — the run() method
		// attaches its own per-command listener with a marker for framing.
		// The initial null byte will be consumed and stripped by run().
	}

	async run(path: string, command: string): Promise<string> {
		this.ensureProcess(path);
		if (!this.proc) throw new Error("r2 process not started");

		const isAnalysis = command.startsWith("aaa") || command.includes("; aaa") || command.startsWith("aa;");
		const timeoutMs = isAnalysis ? 300000 : 60000;

		// Use a marker to detect command completion
		const marker = `__PIRE_END_${Date.now()}__`;
		const stdoutChunks: string[] = [];
		const child = this.proc.child;

		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.stdout?.removeAllListeners("data");
				// Kill the r2 process on timeout — it's in a broken state
				// with pending output that would contaminate the next command.
				try {
					child.kill("SIGKILL");
				} catch {}
				this.proc = null;
				this.currentFile = null;
				// Don't mark as analyzed if the command timed out
				reject(new Error("r2 command timeout"));
			}, timeoutMs);

			const onData = (chunk: Buffer) => {
				stdoutChunks.push(chunk.toString());
				const text = stdoutChunks.join("");
				if (text.includes(marker)) {
					clearTimeout(timeout);
					child.stdout?.removeListener("data", onData);
					// Extract output before the marker
					let output = text.split(marker)[0];
					// Strip leading null bytes from r2 -q0 startup
					output = output.replace(/^\x00+/, "");
					// Only mark as analyzed after successful completion of aaa
					if (isAnalysis && output.length > 0) {
						this.analyzedFiles.add(path);
					}
					resolve(output.trim());
				}
			};
			child.stdout?.on("data", onData);

			// Send command + marker
			this.proc!.stdin.write(`${command}\necho ${marker}\n`);
		});
	}

	getCurrentFile() {
		return this.currentFile;
	}

	dispose() {
		if (this.proc) {
			try {
				this.proc.child.kill();
			} catch {}
			this.proc = null;
		}
	}
}

const r2Session = new R2Session();

const r2Tool: AgentTool<{ path: string; command: string }> = {
	name: "r2",
	executionMode: "sequential",
	description:
		"Run a radare2 command. e.g. 'aaa; afl', 'pdf @ main', 'iz'. Use 'aflj' instead of 'afl' for JSON output (machine-parseable). Use 'afl' address column for decompile tool. For large binaries, use '~' (tilde) to filter output, e.g. 'afl~main' or 'aflj~[0]' to avoid flooding context with hundreds of functions. WARNING: 'f~' (flag list) on large binaries can produce 500KB+ output even with tilde filter — use 'f~pattern' with a specific pattern or use 'afl~pattern' instead.",
	parameters: Type.Object({
		path: Type.String(),
		command: Type.String(),
	}),
	async execute(_id, params) {
		// Update Ghidra target so Ghidra tools auto-load the right binary
		setGhidraTarget(params.path);
		// Auto-run 'aaa' on first call per file, prepend to subsequent commands only if not already analyzed
		const cmd =
			params.command.startsWith("aaa") || r2Session.isAnalyzed(params.path)
				? params.command
				: `aaa; ${params.command}`;
		try {
			return textResult(await r2Session.run(params.path, cmd));
		} catch (e) {
			// If aaa analysis timed out, fall back to lighter 'aa' analysis
			const errMsg = (e as Error).message;
			if (errMsg.includes("timeout") && cmd.startsWith("aaa")) {
				const fallbackCmd = cmd.replace(/^aaa/, "aa");
				try {
					const result = await r2Session.run(params.path, fallbackCmd);
					return textResult(
						result +
							"\n\n[Note: 'aaa' analysis timed out, used 'aa' (lighter analysis) instead. Some functions may not be fully analyzed.]",
					);
				} catch (e2) {
					return textResult(
						`Error: r2 analysis timed out even with 'aa'. The binary may be too large or complex for radare2's analysis. Try running specific r2 commands manually.\n\nOriginal error: ${(e2 as Error).message}`,
					);
				}
			}
			// Non-timeout errors or non-aaa timeouts: return a helpful message
			if (errMsg.includes("timeout")) {
				return textResult(
					`r2 command timed out (60s limit). The command was: ${params.command}\n` +
						"This may happen on very large binaries. Try a simpler command, use '~' to filter output, or use 'aa' instead of 'aaa'.",
				);
			}
			throw e;
		}
	},
};

// ─── r2 Pseudo-Decompiler ─────────────────────────────────────

const decompileTool: AgentTool<{ path: string; address: string; format?: string }> = {
	name: "decompile",
	executionMode: "sequential",
	description:
		"Decompile a function via radare2. Accepts hex addr (e.g. 0x3ca60) or symbol name (e.g. main). Do NOT pass function indices from afl output — use hex addresses from the 'addr' column.",
	parameters: Type.Object({
		path: Type.String(),
		address: Type.String(),
		format: Type.Optional(Type.String({ default: "pdc" })),
	}),
	async execute(_id, params) {
		// Update Ghidra target so Ghidra tools auto-load the right binary
		setGhidraTarget(params.path);
		const fmt = params.format === "pdf" ? "pdf" : "pdc";
		// For symbol names, resolve via r2 first so we seek to the right place
		let seekTarget = params.address;
		if (!/^0x[0-9a-fA-F]+$/.test(params.address) && !/^[0-9a-fA-F]+$/.test(params.address)) {
			// It's a symbol name — r2's `s` command can handle it directly
			// but we use `?v` to validate it resolves
			const checkCmd = r2Session.isAnalyzed(params.path) ? `?v ${params.address}` : `aa; ?v ${params.address}`;
			let resolved: string;
			try {
				resolved = await r2Session.run(params.path, checkCmd);
			} catch {
				resolved = await r2Session.run(params.path, `aa; ?v ${params.address}`);
			}
			const cleaned = resolved.replace(/\x00/g, "").trim();
			if (!cleaned || cleaned === "0x0" || cleaned === "0") {
				return textResult(
					`Symbol "${params.address}" not found in binary. Use 'r2' with 'afl' to list valid function addresses.`,
				);
			}
			seekTarget = params.address; // r2's `s` handles symbol names natively
		}
		const cmd = r2Session.isAnalyzed(params.path) ? `s ${seekTarget}; ${fmt}` : `aaa; s ${seekTarget}; ${fmt}`;
		let result: string;
		try {
			result = await r2Session.run(params.path, cmd);
		} catch (e) {
			if ((e as Error).message.includes("timeout") && cmd.startsWith("aaa")) {
				result = await r2Session.run(params.path, cmd.replace(/^aaa/, "aa"));
			} else {
				throw e;
			}
		}
		// r2 pdc/pdf outputs a null byte or empty string when there's nothing to decompile
		// at the given address (e.g. data section, padding, invalid address)
		let cleaned = result.replace(/\x00/g, "").trim();
		// Also check if pdc output is truncated (no closing brace = incomplete decompilation)
		const isTruncated = cleaned.length > 0 && cleaned.length < 80 && !cleaned.includes("}");
		if (!cleaned || isTruncated) {
			// Try fallback: if pdc produced nothing (or was truncated), try pdf
			if (fmt === "pdc") {
				const fallbackCmd = r2Session.isAnalyzed(params.path)
					? `s ${seekTarget}; pdf`
					: `aaa; s ${seekTarget}; pdf`;
				const fallback = await r2Session.run(params.path, fallbackCmd);
				cleaned = fallback.replace(/\x00/g, "").trim();
			}
			// If pdf also produced nothing, try objdump disassembly as last resort
			if (!cleaned) {
				const objdumpPath = which("objdump");
				if (objdumpPath) {
					const addrNum = parseInt(seekTarget.replace(/^0x/, ""), 16);
					if (!isNaN(addrNum)) {
						const stopAddr = addrNum + 8192;
						const raw = run(
							`${objdumpPath} -d --start-address=0x${addrNum.toString(16)} --stop-address=0x${stopAddr.toString(16)} ${shellEscape(params.path)} ${DEVNULL}`,
							{ timeout: 15000 },
						);
						const lines = raw.split("\n").filter((l) => /^\s+[0-9a-f]+:/.test(l));
						if (lines.length > 0) {
							return textResult(
								`; Disassembly at ${params.address} (objdump fallback — r2 pdc/pdf returned nothing)\n` +
									lines.join("\n"),
							);
						}
					}
				}
				return textResult(
					`No decompilable function found at ${params.address}. The address may be in a data section, alignment padding, or not a function entry point. Use 'r2' with 'afl' to list valid function addresses, or try 'disasm_func' with the hex address.`,
				);
			}
		}
		// Post-process: clean up r2 pdc noise
		cleaned = cleaned
			// Remove endbr64/endbr lines (CET instruction, not useful in pseudo-C)
			.replace(/^\s*endbr\d*\s*$/gm, "")
			// Remove empty lines left by endbr removal
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		return textResult(cleaned);
	},
};

// ─── Ghidra Native Tools ───────────────────────────────────────

const ghidraDecompile: AgentTool<{ function: string; path?: string }> = {
	name: "ghidra_decompile",
	executionMode: "sequential",
	description:
		"Decompile a function via Ghidra (high-quality C pseudocode, much better than r2 pdc). Pass a function name or address (e.g. 'main', 'entry', '0x140001000'). Optionally pass 'path' to specify the binary file to analyze (e.g. '/tmp/binary.exe'). If path is omitted, uses the binary from the last r2/decompile/:load call. First call may take 15-30s to start the Ghidra server and analyze the binary.",
	parameters: Type.Object({
		function: Type.String(),
		path: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		if (params.path) setGhidraTarget(params.path);
		return textResult(ghidra.decompile(params.function));
	},
};

const ghidraListFunctions: AgentTool<{ path?: string }> = {
	name: "ghidra_functions",
	description:
		"List all functions discovered by Ghidra. Optionally pass 'path' to specify the binary file to analyze. If path is omitted, uses the binary from the last r2/decompile/:load call. First call may take 15-30s to start the Ghidra server and analyze the binary.",
	parameters: Type.Object({
		path: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		if (params.path) setGhidraTarget(params.path);
		return textResult(ghidra.listFunctions());
	},
};

const ghidraRename: AgentTool<{ oldName: string; newName: string; path?: string }> = {
	name: "ghidra_rename",
	description: "Rename a function/variable in Ghidra. Optionally pass 'path' to specify the binary.",
	parameters: Type.Object({
		oldName: Type.String(),
		newName: Type.String(),
		path: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		if (params.path) setGhidraTarget(params.path);
		return textResult(ghidra.rename(params.oldName, params.newName));
	},
};

const ghidraXrefs: AgentTool<{ address: string; path?: string }> = {
	name: "ghidra_xrefs",
	description: "List xrefs to an address in Ghidra. Optionally pass 'path' to specify the binary.",
	parameters: Type.Object({
		address: Type.String(),
		path: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		if (params.path) setGhidraTarget(params.path);
		return textResult(ghidra.xrefs(params.address));
	},
};

const ghidraStrings: AgentTool<{ pattern?: string; path?: string }> = {
	name: "ghidra_strings",
	description: "Search strings in Ghidra. Optionally pass 'path' to specify the binary.",
	parameters: Type.Object({
		pattern: Type.Optional(Type.String()),
		path: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		if (params.path) setGhidraTarget(params.path);
		return textResult(ghidra.searchStrings(params.pattern ?? ""));
	},
};

const ghidraStatus: AgentTool<Record<string, never>> = {
	name: "ghidra_status",
	description:
		"Check Ghidra server status. If Ghidra is installed but not running, this will attempt to auto-start the headless server with the currently loaded binary.",
	parameters: Type.Object({}),
	async execute() {
		const alive = ghidra.getStatus().alive;
		if (!alive) {
			const canStart = ghidra.canAutoStart();
			if (canStart) {
				return textResult(
					`Ghidra: offline at ${ghidra.getStatus().url}. Auto-start is available — call ghidra_functions or ghidra_decompile to automatically start the headless server with the loaded binary.`,
				);
			}
			return textResult(
				`Ghidra: offline at ${ghidra.getStatus().url}. No Ghidra installation found or MCP JAR not built.`,
			);
		}
		return textResult(
			`Ghidra: connected at ${ghidra.getStatus().url} (restart attempts: ${ghidra.getStatus().restarts})`,
		);
	},
};

// ─── Auto-Detecting Tool Wrappers ──────────────────────────────
// Each tool checks at execute time if the underlying binary/module exists.
// If not, returns a helpful error. No install-time requirements.

const binwalkTool: AgentTool<{ path: string; extract?: boolean }> = {
	name: "binwalk",
	description: "Scan for embedded files/firmware (binwalk).",
	parameters: Type.Object({
		path: Type.String(),
		extract: Type.Optional(Type.Boolean({ default: false })),
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
	description: "Parse ELF/PE/Mach-O via LIEF. Actions: info, imports, exports, sections, headers, dos.",
	parameters: Type.Object({
		path: Type.String(),
		action: Type.String(),
	}),
	async execute(_id, params) {
		if (!pythonModule("lief")) return textResult("lief not installed. Install: pip install lief");
		const actions: Record<string, string> = {
			info: 'print(json.dumps({"type":str(b.format),"entrypoint":hex(b.entrypoint) if hasattr(b,"entrypoint") else None}))',
			imports: 'print("\\n".join(f"{i.name}@{i.address:#x}" for i in b.imported_functions))',
			exports: 'print("\\n".join(f"{e.name}@{e.address:#x}" for e in b.exported_functions))',
			sections: 'print("\\n".join(f"{s.name} offset={s.offset:#x} size={s.size}" for s in b.sections))',
			headers: "print(json.dumps({k:str(v) for k,v in b.header.__dict__.items()}, indent=2))",
			dos: 'print(b.dos_header.__dict__) if hasattr(b,"dos_header") else print("No DOS header")',
		};
		const action = actions[params.action] ?? 'print("Unknown action")';
		const script = `import lief, json, sys; b=lief.parse("${params.path}"); ${action}`;
		return textResult(run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 15000 }));
	},
};

const angrTool: AgentTool<{ path: string; action: string; target?: string }> = {
	name: "angr",
	description: "Symbolic execution via angr. Actions: cfg, find, properties.",
	parameters: Type.Object({
		path: Type.String(),
		action: Type.String(),
		target: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		if (!pythonModule("angr")) return textResult("angr not installed. Install: pip install angr");
		let script: string;
		if (params.action === "cfg") {
			script = `import angr; p=angr.Project("${params.path}", auto_load_libs=False); cfg=p.analyses.CFGFast(); print(f"Functions: {len(cfg.functions)}"); [print(f"  {n}: {f.addr:#x}") for n,f in list(cfg.functions.items())[:50]]`;
		} else if (params.action === "find" && params.target) {
			// Resolve symbol name to address if not a hex number
			script = `import angr; p=angr.Project("${params.path}", auto_load_libs=False); 
tgt="${params.target}";
try:
    addr=int(tgt,16);
except ValueError:
    sym=p.loader.find_symbol(tgt);
    addr=sym.rebased_addr if sym else None;
    if addr is None: print(f"Symbol not found: {tgt}"); exit(1);
state=p.factory.entry_state(); sm=p.factory.simulation_manager(state); sm.explore(find=addr); print(f"Found: {len(sm.found)} active: {len(sm.active)}"); [print(s.posix.dumps(1)) for s in sm.found[:3]]`;
		} else {
			script = `import angr; p=angr.Project("${params.path}", auto_load_libs=False); print(f"Arch: {p.arch} Entry: {p.entry:#x} PIE: {p.loader.main_object.pic}")`;
		}
		return textResult(
			run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, {
				timeout: 120000,
				maxBuffer: 20 * 1024 * 1024,
			}),
		);
	},
};

const capstoneTool: AgentTool<{ path: string; offset?: number; count?: number; arch?: string; mode?: string }> = {
	name: "capstone",
	description: "Disassemble via Capstone.",
	parameters: Type.Object({
		path: Type.String(),
		offset: Type.Optional(Type.Number({ default: 0 })),
		count: Type.Optional(Type.Number({ default: 50 })),
		arch: Type.Optional(Type.String({ default: "x86" })),
		mode: Type.Optional(Type.String({ default: "64" })),
	}),
	async execute(_id, params) {
		if (!pythonModule("capstone")) return textResult("capstone not installed. Install: pip install capstone");
		const offset = params.offset ?? 0;
		const count = params.count ?? 50;
		const arch = params.arch ?? "x86";
		const mode = params.mode ?? "64";
		const script = `from capstone import *; import struct; data=open("${params.path}","rb").read()[${offset}:${offset}+${count * 15}]; md=Cs(CS_ARCH_${arch.toUpperCase()},CS_MODE_${mode == "64" ? "64" : mode == "32" ? "32" : "ARM"}); [print(f"0x{i.address:x}: {i.mnemonic} {i.op_str}") for i in md.disasm(data,${offset})][:${count}]`;
		return textResult(run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 15000 }));
	},
};

const keystoneTool: AgentTool<{ assembly: string; arch?: string; mode?: string }> = {
	name: "keystone",
	description: "Assemble instructions to bytes (Keystone).",
	parameters: Type.Object({
		assembly: Type.String(),
		arch: Type.Optional(Type.String({ default: "x86" })),
		mode: Type.Optional(Type.String({ description: "Mode: 32, 64, arm (default: 64)", default: "64" })),
	}),
	async execute(_id, params) {
		if (!pythonModule("keystone")) return textResult("keystone not installed. Install: pip install keystone-engine");
		const arch = params.arch ?? "x86";
		const mode = params.mode ?? "64";
		const script = `from keystone import *; ks=Ks(KS_ARCH_${arch.toUpperCase()},KS_MODE_${mode == "64" ? "64" : mode == "32" ? "32" : "ARM"}); encoding,count=ks.asm("${params.assembly.replace(/"/g, '\\"')}"); print(" ".join(f"{b:02x}" for b in encoding))`;
		return textResult(run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}' ${DEVNULL}`, { timeout: 10000 }));
	},
};

const unicornTool: AgentTool<{ path: string; entry?: string; arch?: string; mode?: string; steps?: number }> = {
	name: "unicorn",
	description: "Emulate code via Unicorn Engine.",
	parameters: Type.Object({
		path: Type.String(),
		entry: Type.Optional(Type.String()),
		arch: Type.Optional(Type.String({ default: "x86" })),
		mode: Type.Optional(Type.String({ description: "Mode: 32, 64, arm (default: 64)", default: "64" })),
		steps: Type.Optional(Type.Number({ default: 1000 })),
	}),
	async execute(_id, params) {
		if (!pythonModule("unicorn")) return textResult("unicorn not installed. Install: pip install unicorn");
		const arch = params.arch ?? "x86";
		const mode = params.mode ?? "64";
		const steps = params.steps ?? 1000;
		const entry = params.entry ?? "0";
		const script = `from unicorn import *; from unicorn.x86_const import *; import struct
data=open("${params.path}","rb").read()
uc=Uc(UC_ARCH_${arch.toUpperCase()},UC_MODE_${mode == "64" ? "64" : mode == "32" ? "32" : "ARM"})
uc.mem_map(0x10000, 2*1024*1024)
uc.mem_write(0x10000, data)
entry_off=int("${entry}",16) if "${entry}" else 0
uc.emu_start(0x10000+entry_off, 0x10000+len(data), count=${steps})
rax=uc.reg_read(UC_X86_REG_RAX)
print(f"Emulated ${steps} steps. RAX={rax:#x}")`;
		try {
			return textResult(run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}'`, { timeout: 30000 }));
		} catch (e: any) {
			const stderr = e.stderr ? e.stderr.toString() : "";
			const errLine =
				stderr.split("\n").find((l: string) => l.includes("Error:") || l.includes("error:")) || e.message;
			return textResult(`Unicorn emulation failed: ${errLine.trim()}`);
		}
	},
};

const yaraTool: AgentTool<{ path: string; rule: string }> = {
	name: "yara",
	description: "Scan with YARA rules.",
	parameters: Type.Object({
		path: Type.String(),
		rule: Type.String(),
	}),
	async execute(_id, params) {
		if (!pythonModule("yara")) return textResult("yara-python not installed. Install: pip install yara-python");
		const tmpRule = `/tmp/pire_yara_${Date.now()}.yar`;
		writeFileSync(tmpRule, params.rule);
		try {
			const result = run(
				`${PYTHON} -c "import yara; r=yara.compile('${tmpRule}'); m=r.match('${params.path}'); print('\\\\n'.join(f'{s}: {t}' for m2 in m for s,t in [(m2.rule, 'matched')]) if m else print('No matches'))" ${DEVNULL}`,
				{ timeout: 15000 },
			);
			return textResult(result);
		} finally {
			try {
				run(`rm -f ${tmpRule}`);
			} catch {}
		}
	},
};

const fridaTool: AgentTool<{ target: string; script: string; action: string }> = {
	name: "frida",
	executionMode: "sequential",
	description: "Frida dynamic instrumentation. Actions: spawn, attach, list.",
	parameters: Type.Object({
		target: Type.String(),
		script: Type.Optional(Type.String()),
		action: Type.String(),
	}),
	async execute(_id, params) {
		const fridaBin = which("frida") ?? which("frida-trace");
		if (!fridaBin && !pythonModule("frida"))
			return textResult("frida not installed. Install: pip install frida-tools");
		if (params.action === "list") {
			return textResult(
				run(
					`frida-ps -a ${DEVNULL} || ${PYTHON} -c "import frida; [print(f'{p.pid}: {p.name}') for p in frida.enumerate_devices()[0].enumerate_processes()]"`,
					{ timeout: 10000 },
				),
			);
		}
		const tmpScript = `/tmp/pire_frida_${Date.now()}.js`;
		writeFileSync(tmpScript, params.script ?? "");
		try {
			const flag = params.action === "spawn" ? "-f" : "-p";
			return textResult(
				run(`frida ${flag} ${shellEscape(params.target)} -l ${tmpScript} --no-pause -q 2>&1`, { timeout: 30000 }),
			);
		} finally {
			try {
				run(`rm -f ${tmpScript}`);
			} catch {}
		}
	},
};

const gdbTool: AgentTool<{ path: string; commands: string }> = {
	name: "gdb",
	executionMode: "sequential",
	description: "Run GDB commands on a binary.",
	parameters: Type.Object({
		path: Type.String(),
		commands: Type.String(),
	}),
	async execute(_id, params) {
		const bin = which("gdb");
		if (!bin) return textResult("gdb not installed");
		return textResult(
			run(`${bin} -batch -ex "${params.commands.replace(/"/g, '\\"')}" ${shellEscape(params.path)}`, {
				timeout: 30000,
			}),
		);
	},
};

const volatilityTool: AgentTool<{ memdump: string; plugin: string; extraArgs?: string }> = {
	name: "volatility",
	description: "Volatility 3 memory forensics.",
	parameters: Type.Object({
		memdump: Type.String(),
		plugin: Type.String(),
		extraArgs: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		const vol = which("vol") ?? which("volatility3");
		if (!vol && !pythonModule("volatility3"))
			return textResult("volatility3 not installed. Install: pip install volatility3");
		const cmd = vol ?? `${PYTHON} -m volatility3`;
		try {
			return textResult(
				run(`${cmd} -f ${shellEscape(params.memdump)} ${params.plugin} ${params.extraArgs ?? ""}`, {
					timeout: 60000,
				}),
			);
		} catch (e: any) {
			const stderr = e.stderr ? e.stderr.toString() : "";
			const errLine =
				stderr.split("\n").find((l: string) => l.includes("Error") || l.includes("error")) || e.message;
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
	description: "Extract function disassembly from stripped binary. Full function body, past early-exit rets.",
	parameters: Type.Object({
		path: Type.String(),
		startAddress: Type.String(),
		maxBytes: Type.Optional(Type.Number({ default: 8192 })),
	}),
	async execute(_id, params) {
		let addr = params.startAddress.replace(/^0x/, "");
		const maxBytes = params.maxBytes ?? 8192;

		// Resolve symbolic addresses (e.g. "main", "entry0") to hex via r2
		if (!/^[0-9a-fA-F]+$/.test(addr)) {
			const r2path = which("r2") ?? which("radare2");
			if (r2path) {
				const resolved = run(`${r2path} -qc "?v ${params.startAddress}" ${shellEscape(params.path)} ${DEVNULL}`, {
					timeout: 15000,
				}).trim();
				// r2 ?v prints the resolved address as a hex number
				if (/^0x[0-9a-fA-F]+$/.test(resolved) || /^[0-9a-fA-F]+$/.test(resolved)) {
					addr = resolved.replace(/^0x/, "");
				} else {
					return textResult(
						`Could not resolve symbol "${params.startAddress}" to an address. Use a hex address like 0x1140. r2 output: ${resolved}`,
					);
				}
			} else {
				return textResult(
					`Cannot resolve symbol "${params.startAddress}" without radare2. Provide a hex address like 0x1140.`,
				);
			}
		}

		// Detect PE binary by reading the first 2 bytes (MZ header)
		const isPE = isPEBinary(params.path);

		if (isPE) {
			// Use r2 for PE binaries — objdump is unreliable on PE
			const r2path = which("r2") ?? which("radare2");
			if (r2path) {
				const result = run(`${r2path} -qc "aaa; s 0x${addr}; pdf" ${shellEscape(params.path)} ${DEVNULL}`, {
					timeout: 60000,
				});
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
				startAddress: `0x${addr}`,
				format: "objdump-pe",
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
			// Stop at next function's endbr64 (CET binaries, not Go)
			if (line.includes("endbr64") && instrCount > 0) break;
			// Stop at INT3 padding (common between functions in non-Go binaries)
			if (/	int3/.test(line) && instrCount > 0) break;
			// Stop at nop-padding after a ret (function boundary in Go and others)
			if (/	nop/.test(line) && instrCount > 0 && funcLines.some((l) => /	ret/.test(l))) break;
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
		const retCount = funcLines.filter((l) => /	ret/.test(l)).length;
		return textResult(funcLines.join("\n"), {
			startAddress: `0x${addr}`,
			instructions: instrCount,
			returns: retCount,
		});
	},
};

// ─── Shell tool (sandboxed: restricted cwd, network blocked) ───

/** Runtime toggle for sandbox mode. When false, all commands are allowed. */
let sandboxEnabled = true;

/** Disable or enable the shell sandbox at runtime. */
export function setSandboxEnabled(enabled: boolean): void {
	sandboxEnabled = enabled;
}

/** Commands that could exfiltrate data or make network connections. */
const BLOCKED_PATTERNS = [
	// Network commands — only match at shell command position (start of line or after ;, |, &&, ||)
	// This prevents false positives when "curl" or "wget" appears inside Python strings/heredocs
	/(?:^|;|\||&&|\|\|)\s*(?:curl|wget|nc|netcat)\s/,
	// Standalone network commands at start
	/^(?:curl|wget|nc|netcat)\s/,
	// SSH/file transfer
	/(?:^|;|\||&&|\|\|)\s*(?:ssh|scp|rsync)\s/,
	// Package managers
	/(?:^|;|\||&&|\|\|)\s*(?:apt-get\s+(?:install|remove|purge|upgrade|dist-upgrade|autoremove)|dpkg\s+(?:-i|--install|--configure|--remove|--purge)|yum\s+(?:install|remove|upgrade)|dnf\s+(?:install|remove|upgrade)|pip\s+install|pip3\s+install|npm\s+(?:install|uninstall|update)|npx\s+(?:install|uninstall)|yarn\s+(?:add|remove|upgrade)|pnpm\s+(?:add|remove|upgrade)|brew\s+(?:install|uninstall|upgrade))\s/,
	// Privilege escalation
	/(?:^|;|\||&&|\|\|)\s*(?:sudo|su|doas)\s/,
	// System control
	/(?:^|;|\||&&|\|\|)\s*(?:shutdown|reboot|poweroff|mkfs)\b/,
	// Dangerous dd writes
	/\bdd\s+.*of=\/(?!tmp\/)/,
	// Fork bomb
	/\b:\(\)\{\s*:\|:&\s*\};:/,
	// Network exfiltration via Python inline — only block -c with imports, not script files
	/python3?\s+-c\s+.*(?:import|from)\s+(?:urllib|requests|socket|http)/,
	// Block /dev/tcp and /dev/udp (bash network redirect)
	/\/dev\/(?:tcp|udp)\//,
];

/** Check if a path is within a protected system directory. Returns true if blocked. */
function isProtectedPath(pathStr: string): boolean {
	const resolved = resolve(pathStr);
	const blockedRoots = ["/etc", "/usr", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev", "/lib", "/lib64"];
	for (const blocked of blockedRoots) {
		if (resolved.startsWith(blocked + "/") || resolved === blocked) return true;
	}
	if (resolved.includes("/.ssh/")) return true;
	return false;
}

/** Check if a command matches any blocked pattern. Returns null if allowed. */
function isCommandBlocked(command: string): string | null {
	if (!sandboxEnabled) return null;
	for (const pattern of BLOCKED_PATTERNS) {
		if (pattern.test(command)) {
			return `Command blocked by sandbox: matches pattern "${pattern.source}". The shell tool restricts network access, package management, and privileged commands. Use specific RE tools instead.`;
		}
	}
	return null;
}

const shellTool: AgentTool<{ command: string; cwd?: string }> = {
	name: "shell",
	description: "Run a shell command. Sandbox blocks network/package/privilege escalation.",
	parameters: Type.Object({
		command: Type.String(),
		cwd: Type.Optional(Type.String()),
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
	description: "Download a file from URL.",
	parameters: Type.Object({
		url: Type.String(),
		outputDir: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		// Validate URL — only allow http/https
		try {
			const parsed = new URL(params.url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return textResult(`Blocked: only http/https URLs are allowed (got ${parsed.protocol})`);
			}
		} catch {
			return textResult(`Invalid URL: ${params.url}`);
		}

		const outDir = params.outputDir || "/tmp/pire-downloads";
		try {
			mkdirSync(outDir, { recursive: true });
		} catch {}
		// Derive filename from URL, fallback to timestamp
		const urlPath = params.url.split("?")[0].split("/").pop() || `file_${Date.now()}`;
		// Sanitize filename — prevent path traversal
		const safeName = urlPath.replace(/[^a-zA-Z0-9._-]/g, "_");
		const outPath = join(outDir, safeName);

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
				return textResult(
					`Downloaded to: ${outPath}\nSize: ${statResult.trim()} bytes\nType: ${fileType.split(":")[1]?.trim() ?? "unknown"}`,
					{
						path: outPath,
						url: params.url,
					},
				);
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
	description: "Compute file hashes (md5, sha1, sha256).",
	parameters: Type.Object({
		path: Type.String(),
		algo: Type.Optional(Type.String({ default: "all" })),
	}),
	async execute(_id, params) {
		const algo = params.algo || "all";
		const algos = algo === "all" ? ["md5sum", "sha1sum", "sha256sum"] : [`${algo}sum`];
		const results: string[] = [];
		for (const a of algos) {
			const bin = which(a);
			const label = a.replace("sum", "");
			if (bin) {
				try {
					const out = run(`${bin} ${shellEscape(params.path)}`, { timeout: 30000 });
					results.push(`${label}: ${out.trim()}`);
				} catch {
					results.push(`${label}: error`);
				}
			} else {
				results.push(`${label}: not installed`);
			}
		}
		return textResult(results.join("\n"));
	},
};

// ─── Entropy Tool ──────────────────────────────────────────────

const entropyTool: AgentTool<{ path: string; blockSize?: number }> = {
	name: "entropy",
	description: "Shannon entropy of a file. High = compressed/encrypted.",
	parameters: Type.Object({
		path: Type.String(),
		blockSize: Type.Optional(Type.Number()),
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
    elif e > 6.5: print("NOTE: elevated entropy — may be packed or contain compressed sections")
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
	description: "Extract archives (zip, tar, 7z, rar, deb, rpm).",
	parameters: Type.Object({
		path: Type.String(),
		outputDir: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		// Validate output directory is not a sensitive system path
		const baseName = params.path.split("/").pop() || "extracted";
		const outDir = params.outputDir || join("/tmp/pire-extracted", baseName);
		if (isProtectedPath(outDir)) {
			return textResult(`Extract blocked: ${resolve(outDir)} is a protected system path`);
		}
		try {
			mkdirSync(outDir, { recursive: true });
		} catch {}

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
			try {
				listing = run(`find ${shellEscape(outDir)} -type f | head -50`, { timeout: 10000 });
			} catch {}
			return textResult(`Extracted to: ${outDir}\n${out}\n\nFiles:\n${listing}`, { outputDir: outDir });
		} catch (e: any) {
			return textResult(`Extraction failed: ${e.message}`);
		}
	},
};

// ─── nm Tool (symbol table) ────────────────────────────────────

const nmTool: AgentTool<{ path: string; demangle?: boolean }> = {
	name: "nm",
	description: "List symbols (nm).",
	parameters: Type.Object({
		path: Type.String(),
		demangle: Type.Optional(Type.Boolean({ default: true })),
	}),
	async execute(_id, params) {
		const bin = which("nm");
		if (!bin) return textResult("nm not installed (part of binutils)");
		const flag = params.demangle !== false ? "--demangle" : "";
		try {
			const out = run(`${bin} ${flag} ${shellEscape(params.path)} 2>&1`, {
				timeout: 30000,
				maxBuffer: 5 * 1024 * 1024,
			});
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
	description: "Section sizes (text, data, bss).",
	parameters: Type.Object({
		path: Type.String(),
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
	description: "Diff two files.",
	parameters: Type.Object({
		a: Type.String(),
		b: Type.String(),
		context: Type.Optional(Type.Number({ default: 3 })),
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
	description: "Decompile APK/DEX/JAR to Java (jadx).",
	parameters: Type.Object({
		path: Type.String(),
		outputDir: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		const bin = which("jadx") ?? which("jadx-cli");
		if (!bin) return textResult("jadx not installed. Install from https://github.com/skylot/jadx");
		const baseName = params.path.split("/").pop() || "decompiled";
		const outDir = params.outputDir || join("/tmp/pire-jadx", baseName);
		try {
			mkdirSync(outDir, { recursive: true });
		} catch {}
		try {
			const out = run(`${bin} -d ${shellEscape(outDir)} ${shellEscape(params.path)} 2>&1`, { timeout: 120000 });
			let listing = "";
			try {
				listing = run(`find ${shellEscape(outDir)} -name "*.java" | head -50`, { timeout: 10000 });
			} catch {}
			return textResult(`Decompiled to: ${outDir}\n${out}\n\nJava files:\n${listing}`, { outputDir: outDir });
		} catch (e: any) {
			return textResult(`jadx failed: ${e.message}`);
		}
	},
};

// ─── .NET Decompilation Tool ───────────────────────────────────

const ilspyTool: AgentTool<{ path: string; outputDir?: string }> = {
	name: "ilspy",
	description: "Decompile .NET assemblies to C# (ilspy).",
	parameters: Type.Object({
		path: Type.String(),
		outputDir: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		const ilspy = which("ilspycmd");
		const monodis = which("monodis");
		if (!ilspy && !monodis)
			return textResult(
				"Neither ilspycmd nor monodis installed. Install ilspycmd (dotnet tool install -g ilspycmd) or mono-utils.",
			);
		const baseName = params.path.split("/").pop() || "decompiled";
		const outDir = params.outputDir || join("/tmp/pire-ilspy", baseName);
		try {
			mkdirSync(outDir, { recursive: true });
		} catch {}

		if (ilspy) {
			try {
				const out = run(`${ilspy} ${shellEscape(params.path)} -p -o ${shellEscape(outDir)} 2>&1`, {
					timeout: 120000,
				});
				return textResult(`Decompiled to: ${outDir}\n${out}`, { outputDir: outDir });
			} catch (e: any) {
				return textResult(`ilspycmd failed: ${e.message}`);
			}
		}

		// Fallback: monodis (IL only, not C#)
		try {
			const out = run(
				`${monodis} --output=${shellEscape(join(outDir, "output.il"))} ${shellEscape(params.path)} 2>&1`,
				{ timeout: 60000 },
			);
			return textResult(`Disassembled (IL) to: ${outDir}/output.il\n${out}`, { outputDir: outDir });
		} catch (e: any) {
			return textResult(`monodis failed: ${e.message}`);
		}
	},
};

// ─── Patch/Dump Tool (hex edit at offset) ──────────────────────

const patchTool: AgentTool<{ path: string; offset: string; bytes: string; backup?: boolean }> = {
	name: "patch",
	description: "Patch bytes at a hex offset.",
	parameters: Type.Object({
		path: Type.String(),
		offset: Type.String(),
		bytes: Type.String(),
		backup: Type.Optional(Type.Boolean({ default: true })),
	}),
	async execute(_id, params) {
		// Block patching sensitive system files
		if (isProtectedPath(params.path)) {
			return textResult(`Patch blocked: ${resolve(params.path)} is a protected system path`);
		}
		const backup = params.backup !== false;
		const backupPath = params.path + ".bak";

		if (backup && !existsSync(backupPath)) {
			try {
				if (IS_WIN) {
					run(`copy ${shellEscape(params.path)} ${shellEscape(backupPath)}`);
				} else {
					run(`cp ${shellEscape(params.path)} ${shellEscape(backupPath)} ${DEVNULL}`);
				}
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
			const out = run(`${PYTHON} -c '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000 });
			return textResult(out, { backupPath: backup ? backupPath : undefined });
		} catch (e: any) {
			// Extract just the error line, not the full traceback
			const stderr = e.stderr ? e.stderr.toString() : "";
			const errLine =
				stderr.split("\n").find((l: string) => l.includes("Error:") || l.includes("error:")) || e.message;
			return textResult(`Patch failed: ${errLine.trim()}`);
		}
	},
};

// ─── Search Tool (pattern search in binary) ────────────────────

const searchTool: AgentTool<{ path: string; pattern: string; isHex?: boolean }> = {
	name: "search",
	description: "Search for text/hex pattern in a binary.",
	parameters: Type.Object({
		path: Type.String(),
		pattern: Type.String(),
		isHex: Type.Optional(Type.Boolean({ default: false })),
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
    # Show both hex and ASCII representation for readability
    ascii_repr = ''.join(chr(b) if 32 <= b < 127 else '.' for b in ctx)
    matches.append(f"0x{idx:x}: {ctx.hex(' ')}  |{ascii_repr}|")
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

// ─── Write File Tool ───────────────────────────────────────────

const writeFileTool: AgentTool<{ path: string; content: string }> = {
	name: "write_file",
	description: "Write content to a file. Use this, not shell heredocs.",
	parameters: Type.Object({
		path: Type.String(),
		content: Type.String(),
	}),
	async execute(_id, params) {
		try {
			// Prevent writing to sensitive system paths
			if (isProtectedPath(params.path)) {
				return textResult(`Write blocked: ${resolve(params.path)} is a protected system path`);
			}
			// Block writes to SSH authorized_keys specifically
			const resolved = resolve(params.path);
			if (resolved.endsWith("/.ssh/authorized_keys") || resolved.endsWith("/.ssh/authorized_keys2")) {
				return textResult(`Write blocked: cannot modify SSH authorized_keys`);
			}
			mkdirSync(dirname(params.path), { recursive: true });
			writeFileSync(params.path, params.content);
			return textResult(`Wrote ${params.content.length} bytes to ${params.path}`);
		} catch (e: any) {
			return textResult(`Write failed: ${e.message}`);
		}
	},
};

// ─── Read File Tool ────────────────────────────────────────────

const readFileTool: AgentTool<{ path: string; offset?: number; limit?: number }> = {
	name: "read_file",
	description: "Read a text file with line numbers.",
	parameters: Type.Object({
		path: Type.String(),
		offset: Type.Optional(Type.Number({ default: 1 })),
		limit: Type.Optional(Type.Number({ default: 2000 })),
	}),
	async execute(_id, params) {
		// Block reading sensitive files
		const resolved = resolve(params.path);
		const sensitiveFiles = ["/etc/shadow", "/etc/gshadow"];
		const sensitivePatterns = ["/.ssh/id_", "/.ssh/authorized_keys", "/.ssh/config"];
		for (const sf of sensitiveFiles) {
			if (resolved === sf) return textResult(`Read blocked: ${resolved} is a sensitive system file`);
		}
		for (const sp of sensitivePatterns) {
			if (resolved.includes(sp)) return textResult(`Read blocked: ${resolved} contains SSH credentials`);
		}
		if (!existsSync(params.path)) {
			return textResult(`File not found: ${params.path}`);
		}
		try {
			const content = readFileSync(params.path, "utf-8");
			const lines = content.split("\n");
			const offset = Math.max(1, params.offset ?? 1);
			const limit = Math.min(2000, params.limit ?? 2000);
			const slice = lines.slice(offset - 1, offset - 1 + limit);
			const numbered = slice.map((line: string, i: number) => `${offset + i}| ${line}`).join("\n");
			const total = lines.length;
			let footer = "";
			if (offset + limit - 1 < total) {
				footer = `\n\n(${offset + limit - 1}/${total} lines shown. Use offset=${offset + limit} to continue.)`;
			} else {
				footer = `\n\n(${total}/${total} lines — end of file)`;
			}
			return textResult(numbered + footer, { totalLines: total, offset, limit });
		} catch (e: any) {
			return textResult(`Read failed: ${e.message}`);
		}
	},
};

// ─── Append File Tool ─────────────────────────────────────────

const appendFileTool: AgentTool<{ path: string; content: string }> = {
	name: "append_file",
	description: "Append content to a file (creates if not exists). Use this to incrementally build decompiled source files — append each function as you decompile it, instead of writing one massive file.",
	parameters: Type.Object({
		path: Type.String(),
		content: Type.String(),
	}),
	async execute(_id, params) {
		try {
			const resolved = resolve(params.path);
			if (isProtectedPath(resolved)) {
				return textResult(`Write blocked: ${resolved} is a protected system path`);
			}
			mkdirSync(dirname(params.path), { recursive: true });
			const existing = existsSync(params.path) ? readFileSync(params.path, "utf-8") : "";
			writeFileSync(params.path, existing + params.content);
			return textResult(`Appended ${params.content.length} bytes to ${params.path} (total: ${existing.length + params.content.length} bytes)`);
		} catch (e: any) {
			return textResult(`Append failed: ${e.message}`);
		}
	},
};

// ─── Patch File Tool (find-and-replace, inspired by Hermes agent) ───

const patchFileTool: AgentTool<{ path: string; old: string; new: string }> = {
	name: "patch_file",
	description: "Find-and-replace in a file. Finds 'old' string and replaces with 'new'. Use this for surgical edits to existing files instead of rewriting the whole file. The 'old' string must be unique in the file. Pass replace_all=true to replace all occurrences.",
	parameters: Type.Object({
		path: Type.String(),
		old: Type.String(),
		new: Type.String(),
	}),
	async execute(_id, params) {
		try {
			const resolved = resolve(params.path);
			if (isProtectedPath(resolved)) {
				return textResult(`Patch blocked: ${resolved} is a protected system path`);
			}
			if (!existsSync(params.path)) {
				return textResult(`Patch failed: file not found: ${params.path}`);
			}
			const content = readFileSync(params.path, "utf-8");
			const count = content.split(params.old).length - 1;
			if (count === 0) {
				return textResult(`Patch failed: string not found in ${params.path}. The 'old' string must exist in the file.`);
			}
			if (count > 1) {
				return textResult(`Patch failed: found ${count} occurrences of the 'old' string. Make it more unique (include surrounding context lines).`);
			}
			const patched = content.replace(params.old, params.new);
			writeFileSync(params.path, patched);
			return textResult(`Patched ${params.path}: replaced ${params.old.length} chars with ${params.new.length} chars`);
		} catch (e: any) {
			return textResult(`Patch failed: ${e.message}`);
		}
	},
};

// ─── Tool Registry ─────────────────────────────────────────────

/** Validate that required tool parameters are present and non-empty. Returns error string or null. */
export function validateToolParams(tool: AgentTool<any>, params: Record<string, unknown>): string | null {
	const schema = tool.parameters as any;
	const required: string[] = schema?.required ?? Object.keys(schema?.properties ?? {});
	for (const key of required) {
		const val = params[key];
		if (val === undefined || val === null || val === "") {
			return `Missing required parameter "${key}" for tool "${tool.name}". You must provide this parameter. Please retry the tool call with all required parameters filled in.`;
		}
	}
	return null;
}

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
	// File I/O
	writeFileTool,
	readFileTool,
	appendFileTool,
	patchFileTool,
];

export function createReTools(extra: AgentTool<any>[] = []): AgentTool<any>[] {
	return [...RE_TOOLS, ...extra];
}

/** Probe system for available tools and return status. */
export function probeTools(): Record<string, boolean> {
	const ghidraInstalled = !!which("ghidra") || !!which("ghidraRun");
	const ghidraOk = ghidra.getStatus().alive;
	const ghidraReady = ghidra.canAutoStart();
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
		ghidra_status: ghidraInstalled,
		ghidra_decompile: ghidraOk || ghidraReady,
		ghidra_functions: ghidraOk || ghidraReady,
		ghidra_rename: ghidraOk || ghidraReady,
		ghidra_xrefs: ghidraOk || ghidraReady,
		ghidra_strings: ghidraOk || ghidraReady,
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
		write_file: true,
		read_file: true,
		append_file: true,
		patch_file: true,
	};
}

// ─── System Prompt ─────────────────────────────────────────────

export const RE_SYSTEM_PROMPT = `You are pire, a reverse engineering agent. Analyze any binary or software artifact.

Run tools automatically — adapt to the task. Use filetype first, then pick tools. Run PE binaries with WINEPREFIX=$HOME/.wine wine <binary>. Use write_file for source code, not shell heredocs.

DECOMPILATION: Always prefer ghidra_decompile over r2's decompile tool — Ghidra produces much higher quality C pseudocode. You can pass 'path' directly to ghidra_decompile or ghidra_functions to specify the binary (e.g. {"function":"entry","path":"/tmp/binary.exe"}). The first Ghidra call may take 15-30 seconds to start the server and analyze the binary — this is normal, just wait. If Ghidra fails, fall back to r2 decompile with format "pdf".

IMPORTANT — MANAGING DECOMPILATION OUTPUT: Context is limited. Do NOT try to hold all decompiled functions in your context at once. After decompiling each function, IMMEDIATELY append it to a file using append_file (e.g. /tmp/decompiled.c) before decompiling the next function. When you're ready to reconstruct source, read_file the collected decompilations. Never decompile more than 8 functions without saving them to a file first.

Rules: Work on copies (patch tool creates backups). Quote exact addresses. If unsure about a constant, say so. If a tool call fails or returns an error, retry with corrected parameters — do not stop or give up.

When listing functions with r2, use 'aflj' (JSON) for parseable output. When decompiling with r2, pass hex addresses (e.g. 0x3ca60) from the 'addr' column — never pass function indices.

When writing analysis files, use the write_file tool directly with the full content. Do not use shell heredocs or echo commands. For large source files, build them incrementally: use write_file for the first chunk, then append_file for subsequent chunks. For surgical edits to existing files, use patch_file (find-and-replace).`;

// ─── Exports ───────────────────────────────────────────────────

export {
	shellTool,
	fetchTool,
	extractTool,
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
	hashTool,
	entropyTool,
	diffTool,
	ghidraStatus,
	ghidraDecompile,
	ghidraListFunctions,
	ghidraRename,
	ghidraXrefs,
	ghidraStrings,
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
	jadxTool,
	ilspyTool,
	writeFileTool,
	readFileTool,
	appendFileTool,
	patchFileTool,
};
