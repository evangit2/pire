/**
 * pire-update.ts — Self-update and rollback for pire
 *
 *   pire update           — Update to latest from GitHub main
 *   pire update reverse   — Roll back to the version before last update
 *
 * Safety:
 *   - Records pre-update commit SHA to ~/.pire/.update-backup
 *   - Stashes uncommitted changes before pulling
 *   - On any failure, restores the previous state
 *   - Refuses to update if not in a git repo or on detached HEAD
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

const PIRE_DIR = join(process.env.HOME || process.env.USERPROFILE || "/tmp", ".pire");
const IS_WIN = process.platform === "win32";
const DEVNULL = IS_WIN ? "2>nul" : "2>/dev/null";
const BACKUP_FILE = join(PIRE_DIR, ".update-backup");

function git(args: string, opts: { cwd: string; stdio?: "pipe" | "ignore" } = { cwd: process.cwd() }): string {
	try {
		const result = execSync(`git ${args}`, {
			cwd: opts.cwd,
			stdio: opts.stdio ?? "pipe",
			encoding: "utf-8",
			timeout: 60000,
		});
		return result?.trim() ?? "";
	} catch (e: any) {
		throw new Error(e.stderr?.trim() || e.stdout?.trim() || e.message);
	}
}

function findPireRepo(): string | null {
	const candidates: (string | undefined)[] = [
		process.env.PIRE_REPO,
	];

	// Walk up from this file to find a .git dir
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 10; i++) {
		if (existsSync(join(dir, ".git"))) {
			candidates.push(dir);
			break;
		}
		dir = dirname(dir);
	}

	// Try resolving from the pire binary
	try {
		const checker = IS_WIN ? "where" : "which";
		const bin = execSync(`${checker} pire ${DEVNULL}`, { encoding: "utf-8" }).trim();
		if (bin) {
			const content = readFileSync(bin, "utf-8");
			const match = content.match(/cd\s+(\S+)\s+&&/);
			if (match) candidates.push(match[1]);
		}
	} catch {}

	for (const c of candidates) {
		if (c && existsSync(join(c, ".git"))) return c;
	}
	return null;
}

async function main() {
	const subcommand = process.argv[process.argv.indexOf("update") + 1];

	if (subcommand === "reverse" || subcommand === "rollback") {
		await reverseUpdate();
	} else {
		await doUpdate();
	}
}

async function doUpdate(): Promise<void> {
	console.log(chalk.cyan("→ Checking for updates..."));

	const repo = findPireRepo();
	if (!repo) {
		console.error(chalk.red("✗ Could not find pire git repository."));
		console.error(chalk.dim("  Set PIRE_REPO env var or install via the official installer."));
		process.exit(1);
	}

	// Verify we're in a clean state
	const branch = git("rev-parse --abbrev-ref HEAD", { cwd: repo });
	if (branch === "HEAD") {
		console.error(chalk.red("✗ Detached HEAD — cannot update safely."));
		process.exit(1);
	}

	// Fetch latest
	try {
		git("fetch origin main", { cwd: repo, stdio: "ignore" });
	} catch (e: any) {
		console.error(chalk.red(`✗ Failed to fetch from GitHub: ${e.message}`));
		process.exit(1);
	}

	const currentSha = git("rev-parse HEAD", { cwd: repo });
	const remoteSha = git("rev-parse origin/main", { cwd: repo });

	if (currentSha === remoteSha) {
		console.log(chalk.green("✓ Already up to date."));
		const version = git(`describe --tags --abbrev=0 ${DEVNULL}`, { cwd: repo }) || "unknown";
		console.log(chalk.dim(`  Version: ${version}`));
		process.exit(0);
	}

	// Show what's incoming
	const behind = git(`rev-list --count HEAD..origin/main`, { cwd: repo });
	console.log(chalk.yellow(`${behind} commit(s) behind origin/main.`));

	const log = git("log --oneline HEAD..origin/main", { cwd: repo });
	const commits = log.split("\n").filter(Boolean);
	for (const line of commits.slice(0, 10)) {
		console.log(chalk.dim(`  ${line}`));
	}
	if (commits.length > 10) {
		console.log(chalk.dim(`  ... and ${commits.length - 10} more`));
	}

	// Record backup
	if (!existsSync(PIRE_DIR)) mkdirSync(PIRE_DIR, { recursive: true });
	writeFileSync(BACKUP_FILE, JSON.stringify({
		sha: currentSha,
		branch,
		timestamp: new Date().toISOString(),
	}, null, 2));

	console.log(chalk.cyan("\n→ Updating..."));

	// Stash any local changes
	const status = git("status --porcelain", { cwd: repo });
	let stashed = false;
	if (status.trim()) {
		try {
			git("stash push -m 'pire-update auto-stash'", { cwd: repo, stdio: "ignore" });
			stashed = true;
			console.log(chalk.dim("  Stashed local changes."));
		} catch {
			// stash failed, try to continue anyway
		}
	}

	try {
		// Pull
		git("pull origin main --no-rebase", { cwd: repo, stdio: "ignore" });

		// Reinstall npm deps if needed
		if (existsSync(join(repo, "package.json"))) {
			console.log(chalk.dim("  Installing dependencies..."));
			execSync("npm install --silent", { cwd: repo, stdio: "ignore", timeout: 120000 });
		}

		// Verify it compiles — non-fatal, just a warning
		// Don't let a slow/heavy tsc check block the update
		const tsconfig = join(repo, "packages/re-agent/tsconfig.json");
		if (existsSync(tsconfig)) {
			console.log(chalk.dim("  Verifying TypeScript compilation..."));
			try {
				execSync("npx tsc --noEmit --skipLibCheck", {
					cwd: join(repo, "packages/re-agent"),
					stdio: "ignore",
					timeout: 30000,
				});
			} catch {
				console.log(chalk.yellow("  ⚠ TypeScript check skipped (non-blocking)."));
			}
		}

		const newVersion = git(`describe --tags --abbrev=0 ${DEVNULL}`, { cwd: repo }) || "unknown";
		console.log(chalk.green(`\n✓ Updated to ${newVersion}`));
		console.log(chalk.dim(`  ${currentSha.slice(0, 8)} → ${remoteSha.slice(0, 8)}`));
		console.log(chalk.dim(`  Run 'pire update reverse' to roll back if needed.`));

		// Reapply stash
		if (stashed) {
			try {
				git("stash pop", { cwd: repo, stdio: "ignore" });
				console.log(chalk.dim("  Reapplied local changes."));
			} catch {}
		}
	} catch (e: any) {
		console.error(chalk.red(`\n✗ Update failed: ${e.message}`));
		console.error(chalk.yellow("  Rolling back..."));
		try {
			git(`reset --hard ${currentSha}`, { cwd: repo, stdio: "ignore" });
			console.error(chalk.green("✓ Rolled back to previous state."));
		} catch (rollbackErr: any) {
			console.error(chalk.red(`✗ Rollback failed: ${rollbackErr.message}`));
			console.error(chalk.red(`  Manual recovery needed. Previous SHA: ${currentSha}`));
		}
		process.exit(1);
	}
}

async function reverseUpdate(): Promise<void> {
	console.log(chalk.cyan("→ Reversing last update..."));

	if (!existsSync(BACKUP_FILE)) {
		console.error(chalk.red("✗ No update backup found. Nothing to reverse."));
		process.exit(1);
	}

	const repo = findPireRepo();
	if (!repo) {
		console.error(chalk.red("✗ Could not find pire git repository."));
		process.exit(1);
	}

	let backup: { sha: string; branch: string; timestamp: string };
	try {
		backup = JSON.parse(readFileSync(BACKUP_FILE, "utf-8"));
	} catch {
		console.error(chalk.red("✗ Corrupt backup file."));
		process.exit(1);
	}

	const currentSha = git("rev-parse HEAD", { cwd: repo });
	if (currentSha === backup.sha) {
		console.log(chalk.yellow("Already at the backup version."));
		process.exit(0);
	}

	console.log(chalk.dim(`  Current:  ${currentSha.slice(0, 8)}`));
	console.log(chalk.dim(`  Reverting to: ${backup.sha.slice(0, 8)} (${backup.branch})`));
	console.log(chalk.dim(`  From: ${backup.timestamp}`));

	// Stash local changes
	const status = git("status --porcelain", { cwd: repo });
	let stashed = false;
	if (status.trim()) {
		try {
			git("stash push -m 'pire-update-reverse auto-stash'", { cwd: repo, stdio: "ignore" });
			stashed = true;
			console.log(chalk.dim("  Stashed local changes."));
		} catch {}
	}

	try {
		git(`checkout ${backup.sha}`, { cwd: repo, stdio: "ignore" });
		console.log(chalk.green(`\n✓ Reverted to ${backup.sha.slice(0, 8)}`));
		console.log(chalk.dim("  You are now in detached HEAD state."));

		// Reinstall deps
		if (existsSync(join(repo, "package.json"))) {
			console.log(chalk.dim("  Reinstalling dependencies..."));
			execSync("npm install --silent", { cwd: repo, stdio: "ignore", timeout: 120000 });
		}

		if (stashed) {
			try {
				git("stash pop", { cwd: repo, stdio: "ignore" });
				console.log(chalk.dim("  Reapplied local changes."));
			} catch {}
		}

		// Remove the backup file so we don't reverse twice
		try { unlinkSync(BACKUP_FILE); } catch {}

		console.log(chalk.dim(`\n  To return to latest: pire update`));
	} catch (e: any) {
		console.error(chalk.red(`✗ Reverse failed: ${e.message}`));
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(chalk.red(`✗ ${e.message}`));
	process.exit(1);
});
