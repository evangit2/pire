/**
 * pire-uninstall.ts — Complete uninstall for pire
 *
 *   pire uninstall           — Remove pire + optionally all RE packages
 *
 * What it removes (always):
 *   - /usr/local/bin/pire wrapper
 *   - Global tsx
 *   - ~/.pire repo (if installed via curl|sh)
 *   - ~/.pire config dir
 *
 * Then asks the user if they want to also remove the RE packages
 * that the installer installed (wine, mingw, ghidra, frida, gdb,
 * binwalk, jadx, ilspy, yara, volatility, python RE tools, etc.)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const IS_WIN = process.platform === "win32";
const DEVNULL = IS_WIN ? "2>nul" : "2>/dev/null";
const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";
const PIRE_DIR = join(HOME, ".pire");

// ─── Helpers ───────────────────────────────────────────────────

function run(cmd: string, opts: { stdio?: "pipe" | "ignore" } = {}): string {
	try {
		return (
			execSync(cmd, {
				encoding: "utf-8",
				stdio: opts.stdio ?? "pipe",
				timeout: 60000,
			})?.trim() ?? ""
		);
	} catch {
		return "";
	}
}

function has(cmd: string): boolean {
	return !!run(`command -v ${cmd} ${DEVNULL}`);
}

async function confirm(rl: any, question: string, defaultYes = false): Promise<boolean> {
	const answer = (await rl.question(question)).trim().toLowerCase();
	if (answer === "") return defaultYes;
	return answer === "y" || answer === "yes";
}

// ─── Detect OS ─────────────────────────────────────────────────

function detectOS(): string {
	if (IS_WIN) return "windows";
	if (process.platform === "darwin") return "macos";
	try {
		const id = run(". /etc/os-release 2>/dev/null && echo $ID");
		if (id.includes("ubuntu") || id.includes("debian") || id.includes("linuxmint") || id.includes("pop"))
			return "debian";
		if (
			id.includes("fedora") ||
			id.includes("rhel") ||
			id.includes("centos") ||
			id.includes("rocky") ||
			id.includes("almalinux")
		)
			return "fedora";
		if (id.includes("arch") || id.includes("manjaro")) return "arch";
		if (id.includes("suse") || id.includes("opensuse")) return "suse";
		if (id.includes("alpine")) return "alpine";
	} catch {}
	return "linux";
}

function detectPkgMgr(os: string): string {
	if (os === "macos") return "brew";
	if (os === "windows") return "choco";
	const which = run(
		"command -v apt-get || command -v dnf || command -v pacman || command -v zypper || command -v apk",
	);
	if (which.includes("apt-get")) return "apt";
	if (which.includes("dnf")) return "dnf";
	if (which.includes("pacman")) return "pacman";
	if (which.includes("zypper")) return "zypper";
	if (which.includes("apk")) return "apk";
	return "";
}

// ─── Package lists per OS ──────────────────────────────────────

interface PkgEntry {
	name: string;
	label: string;
}

function corePackages(os: string, pkgmgr: string): PkgEntry[] {
	switch (os) {
		case "macos":
			return [
				{ name: "node", label: "Node.js" },
				{ name: "radare2", label: "radare2" },
				{ name: "binutils", label: "binutils" },
				{ name: "coreutils", label: "coreutils (gtimeout)" },
				{ name: "python@3", label: "Python 3 (Homebrew)" },
			];
		case "debian":
			return [
				{ name: "nodejs", label: "Node.js" },
				{ name: "npm", label: "npm" },
				{ name: "radare2", label: "radare2" },
				{ name: "binutils", label: "binutils" },
				{ name: "python3-pip", label: "pip" },
				{ name: "python3-venv", label: "venv" },
			];
		case "fedora":
			return [
				{ name: "nodejs", label: "Node.js" },
				{ name: "npm", label: "npm" },
				{ name: "radare2", label: "radare2" },
				{ name: "binutils", label: "binutils" },
				{ name: "python3-pip", label: "pip" },
			];
		case "arch":
			return [
				{ name: "nodejs", label: "Node.js" },
				{ name: "npm", label: "npm" },
				{ name: "radare2", label: "radare2" },
				{ name: "binutils", label: "binutils" },
				{ name: "python-pip", label: "pip" },
			];
		default:
			return [];
	}
}

function optionalPackages(os: string): PkgEntry[] {
	switch (os) {
		case "macos":
			return [
				{ name: "wine", label: "Wine" },
				{ name: "mingw-w64", label: "MinGW-w64" },
				{ name: "gdb", label: "GDB" },
				{ name: "binwalk", label: "Binwalk" },
				{ name: "jadx", label: "JADX" },
				{ name: "yara", label: "Yara" },
				{ name: "ghidra", label: "Ghidra" },
			];
		case "debian":
			return [
				{ name: "wine64", label: "Wine" },
				{ name: "gcc-mingw-w64-x86-64", label: "MinGW-w64" },
				{ name: "gdb", label: "GDB" },
				{ name: "binwalk", label: "Binwalk" },
				{ name: "default-jre", label: "Java (JADX/ILSpy)" },
				{ name: "yara", label: "Yara" },
				{ name: "python3-frida", label: "Frida" },
				{ name: "ghidra", label: "Ghidra" },
			];
		case "fedora":
			return [
				{ name: "wine", label: "Wine" },
				{ name: "mingw64-gcc", label: "MinGW-w64" },
				{ name: "gdb", label: "GDB" },
				{ name: "binwalk", label: "Binwalk" },
				{ name: "yara", label: "Yara" },
				{ name: "ghidra", label: "Ghidra" },
			];
		case "arch":
			return [
				{ name: "wine", label: "Wine" },
				{ name: "mingw-w64-gcc", label: "MinGW-w64" },
				{ name: "gdb", label: "GDB" },
				{ name: "binwalk", label: "Binwalk" },
				{ name: "yara", label: "Yara" },
				{ name: "frida-tools", label: "Frida" },
				{ name: "ghidra", label: "Ghidra" },
			];
		default:
			return [];
	}
}

function pythonPackages(): PkgEntry[] {
	return [
		{ name: "capstone", label: "capstone" },
		{ name: "unicorn", label: "unicorn" },
		{ name: "lief", label: "lief" },
		{ name: "angr", label: "angr" },
		{ name: "keystone-engine", label: "keystone" },
		{ name: "frida-tools", label: "frida-tools" },
		{ name: "frida", label: "frida" },
		{ name: "volatility3", label: "volatility3" },
		{ name: "yara-python", label: "yara-python" },
		{ name: "binwalk", label: "binwalk (pip)" },
	];
}

// ─── Find pire repo ────────────────────────────────────────────

function findPireRepo(): string | null {
	// Check ~/.pire first (curl|sh install)
	if (existsSync(join(PIRE_DIR, ".git")) && existsSync(join(PIRE_DIR, "package.json"))) {
		return PIRE_DIR;
	}
	// Check PIRE_REPO env
	if (process.env.PIRE_REPO && existsSync(join(process.env.PIRE_REPO, ".git"))) {
		return process.env.PIRE_REPO;
	}
	// Walk up from this file
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		if (existsSync(join(dir, ".git"))) return dir;
		dir = dirname(dir);
	}
	// Try from the pire binary wrapper
	try {
		const bin = run(`which pire ${DEVNULL}`);
		if (bin) {
			const content = readFileSync(bin, "utf-8");
			const match = content.match(/cd\s+(\S+)\s+&&/) || content.match(/tsx\s+"([^"]+)"/);
			if (match) {
				const p = match[1].replace(/\/packages\/.*/, "");
				if (existsSync(join(p, ".git"))) return p;
			}
		}
	} catch {}
	return null;
}

// ─── Uninstall functions ───────────────────────────────────────

function pkgUninstall(pkgmgr: string, pkgs: PkgEntry[]): void {
	for (const pkg of pkgs) {
		process.stdout.write(`  ${chalk.dim("→")} ${pkg.label}... `);

		// Ghidra is installed to /opt, not via package manager
		if (pkg.name === "ghidra") {
			run("sudo rm -rf /opt/ghidra_* 2>/dev/null || rm -rf /opt/ghidra_* 2>/dev/null");
			run("sudo rm -f /usr/local/bin/ghidra 2>/dev/null || rm -f /usr/local/bin/ghidra 2>/dev/null");
			run("rm -f $HOME/.local/bin/ghidra 2>/dev/null");
			console.log(chalk.green("done"));
			continue;
		}

		let cmd = "";
		switch (pkgmgr) {
			case "brew":
				cmd = `brew uninstall ${pkg.name} ${DEVNULL}`;
				break;
			case "apt":
				cmd = `sudo apt-get remove -y ${pkg.name} ${DEVNULL}`;
				break;
			case "dnf":
				cmd = `sudo dnf remove -y ${pkg.name} ${DEVNULL}`;
				break;
			case "pacman":
				cmd = `sudo pacman -R --noconfirm ${pkg.name} ${DEVNULL}`;
				break;
			case "zypper":
				cmd = `sudo zypper remove -y ${pkg.name} ${DEVNULL}`;
				break;
			case "apk":
				cmd = `sudo apk del ${pkg.name} ${DEVNULL}`;
				break;
			case "choco":
				cmd = `choco uninstall -y ${pkg.name} ${DEVNULL}`;
				break;
		}
		if (cmd) {
			run(cmd);
		}
		console.log(chalk.green("done"));
	}
}

function pipUninstall(pkgs: PkgEntry[]): void {
	// Find the right python
	const candidates =
		process.platform === "darwin" ? ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "python3"] : ["python3"];
	let py = "python3";
	for (const p of candidates) {
		if (run(`command -v ${p} ${DEVNULL}`)) {
			py = p;
			break;
		}
	}
	let flags = "--user --break-system-packages";
	if (!run(`${py} -m pip install --help 2>/dev/null | grep -- --break-system-packages`)) {
		flags = "--user";
	}
	for (const pkg of pkgs) {
		process.stdout.write(`  ${chalk.dim("→")} ${pkg.label}... `);
		run(`${py} -m pip uninstall -y ${flags} ${pkg.name} ${DEVNULL}`);
		console.log(chalk.green("done"));
	}
}

function removeDir(path: string, label: string): void {
	if (existsSync(path)) {
		process.stdout.write(`  ${chalk.dim("→")} ${label}... `);
		try {
			rmSync(path, { recursive: true, force: true });
			console.log(chalk.green("done"));
		} catch {
			console.log(chalk.yellow("partial"));
		}
	}
}

function removeFile(path: string, label: string): void {
	if (existsSync(path)) {
		process.stdout.write(`  ${chalk.dim("→")} ${label}... `);
		try {
			run(`sudo rm -f '${path}' ${DEVNULL}`) || run(`rm -f '${path}' ${DEVNULL}`);
			console.log(chalk.green("done"));
		} catch {
			console.log(chalk.yellow("failed"));
		}
	}
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
	const rl = createInterface({ input: stdin, output: stdout });

	console.log(chalk.cyan("\n╔═══════════════════════════════════════════════════════════╗"));
	console.log(chalk.cyan("║  pire Uninstaller                                         ║"));
	console.log(chalk.cyan("║  github.com/evangit2/pire                                 ║"));
	console.log(chalk.cyan("╚═══════════════════════════════════════════════════════════╝\n"));

	const os = detectOS();
	const pkgmgr = detectPkgMgr(os);
	const repo = findPireRepo();

	console.log(chalk.dim(`  OS: ${os}  |  Package manager: ${pkgmgr || "unknown"}`));
	if (repo) console.log(chalk.dim(`  Repo: ${repo}`));
	console.log();

	// ── Step 1: Always remove pire itself ──────────────────────
	console.log(chalk.cyan("═══ Step 1: Remove pire ═══"));
	console.log();

	// Remove /usr/local/bin/pire
	removeFile("/usr/local/bin/pire", "pire CLI wrapper");

	// Remove global tsx
	if (has("tsx")) {
		process.stdout.write(`  ${chalk.dim("→")} global tsx... `);
		run("npm uninstall -g tsx 2>/dev/null");
		console.log(chalk.green("done"));
	}

	// Remove pire repo (if curl|sh install at ~/.pire)
	if (repo && repo === PIRE_DIR) {
		removeDir(repo, "pire repo (~/.pire)");
	} else if (repo) {
		console.log(chalk.yellow(`\n  ⚠ pire repo is at ${repo}`));
		console.log(chalk.yellow("    This looks like a manual clone — not removing automatically."));
		const removeRepo = await confirm(rl, chalk.yellow("  Remove it anyway? [Y/n] "), true);
		if (removeRepo) removeDir(repo, "pire repo");
	}

	// Remove ~/.pire config dir (if different from repo, or if repo wasn't there)
	if (existsSync(PIRE_DIR) && repo !== PIRE_DIR) {
		removeDir(PIRE_DIR, "pire config (~/.pire)");
	}

	console.log();
	console.log(chalk.green("✓ pire core removed.\n"));

	// ── Step 2: Ask about optional packages ────────────────────
	console.log(chalk.cyan("═══ Step 2: Remove RE packages? ═══"));
	console.log();
	console.log(chalk.dim("  The installer also installed these RE tools."));
	console.log(chalk.dim("  You can keep them (useful for other projects) or remove them now."));
	console.log();

	const optPkgs = optionalPackages(os);
	const corePkgs = corePackages(os, pkgmgr);
	const pyPkgs = pythonPackages();

	// Show what's installed
	console.log(chalk.white("  Currently installed (detected):"));
	const allPkgs = [...optPkgs, ...corePkgs];
	for (const pkg of allPkgs) {
		const installed =
			os === "macos"
				? !!run(`brew list ${pkg.name} ${DEVNULL} 2>/dev/null`)
				: !!run(
						`command -v ${pkg.name} ${DEVNULL} || ${pkgmgr} list --installed 2>/dev/null | grep -q ${pkg.name}`,
					);
		if (installed) {
			console.log(`    ${chalk.green("✓")} ${pkg.label}`);
		}
	}
	// Check python packages
	for (const pkg of pyPkgs) {
		const py = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "python3";
		if (
			run(
				`${py} -c "import ${pkg.name.replace("-engine", "").replace("-python", "").replace("-tools", "")}" ${DEVNULL} 2>/dev/null`,
			) !== undefined
		) {
			// Simplified check
		}
	}
	console.log();

	const removeOpt = await confirm(
		rl,
		chalk.yellow("  Remove optional RE packages (wine, mingw, gdb, binwalk, jadx, yara, etc.)? [y/N] "),
	);
	console.log();

	if (removeOpt && optPkgs.length > 0) {
		console.log(chalk.cyan("  Removing optional packages..."));
		pkgUninstall(pkgmgr, optPkgs);
		// Clean up symlinks created by the installer
		for (const link of ["readelf", "frida", "frida-ps", "frida-trace", "ghidra"]) {
			const linkPath = `${HOME}/.local/bin/${link}`;
			if (existsSync(linkPath)) {
				run(`rm -f "${linkPath}" 2>/dev/null`);
			}
		}
		console.log();
	}

	const removePy = await confirm(
		rl,
		chalk.yellow("  Remove Python RE packages (capstone, unicorn, angr, lief, frida, volatility3, etc.)? [y/N] "),
	);
	console.log();

	if (removePy) {
		console.log(chalk.cyan("  Removing Python packages..."));
		pipUninstall(pyPkgs);
		console.log();
	}

	const removeCore = await confirm(
		rl,
		chalk.yellow("  Remove core packages (node, radare2, binutils, python)? [y/N] "),
	);
	console.log();

	if (removeCore && corePkgs.length > 0) {
		console.log(chalk.cyan("  Removing core packages..."));
		pkgUninstall(pkgmgr, corePkgs);
		console.log();
	}

	rl.close();

	console.log(chalk.green("═══════════════════════════════════════════════════════════"));
	console.log(chalk.green("  pire has been completely uninstalled."));
	console.log(chalk.green("═══════════════════════════════════════════════════════════"));
	console.log();
	console.log(chalk.dim("  Thanks for trying pire!"));
	console.log();
}

main().catch((e) => {
	console.error(chalk.red(`✗ ${e.message}`));
	process.exit(1);
});
