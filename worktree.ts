import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface WorktreeResult {
	worktreePath: string;
	branch: string;
	headCommit: string;
	gitRoot: string;
}

export interface WorktreeConfig {
	symlinkDirs?: string[];
}

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

function gitMaybe(args: string[], cwd: string): string | null {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) return null;
	return result.stdout.trim();
}

function realpathIfExists(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

function readGitdirPointer(gitFile: string): string | null {
	let content: string;
	try {
		content = readFileSync(gitFile, "utf-8").trim();
	} catch {
		return null;
	}
	if (!content.startsWith("gitdir:")) return null;

	const rawGitDir = content.slice("gitdir:".length).trim();
	const gitDir = resolve(dirname(gitFile), rawGitDir);
	return realpathIfExists(gitDir);
}

function resolveCommonDir(gitDir: string): string | null {
	const commonDirFile = join(gitDir, "commondir");
	if (!existsSync(commonDirFile)) return gitDir;

	let rawCommonDir: string;
	try {
		rawCommonDir = readFileSync(commonDirFile, "utf-8").trim();
	} catch {
		return null;
	}
	const commonDir = resolve(gitDir, rawCommonDir);
	return realpathIfExists(commonDir);
}

function canonicalRootFromGitFile(gitFile: string): string | null {
	const gitDir = readGitdirPointer(gitFile);
	if (!gitDir) return null;

	const commonDir = resolveCommonDir(gitDir);
	if (!commonDir) return null;

	return realpathIfExists(dirname(commonDir));
}

export function findGitRoot(cwd: string): string | null {
	let current = realpathIfExists(cwd);
	if (!current) return null;

	while (true) {
		const dotGit = join(current, ".git");
		if (existsSync(dotGit)) {
			const dotGitStat = lstatSync(dotGit);
			if (dotGitStat.isDirectory()) return realpathIfExists(current);
			if (dotGitStat.isFile()) return canonicalRootFromGitFile(dotGit);
		}

		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function worktreesDir(gitRoot: string): string {
	return join(gitRoot, ".pi", "worktrees");
}

function worktreeBranchName(slug: string): string {
	return `pi-worktree-${slug}`;
}

export function createWorktree(gitRoot: string, slug: string, config: WorktreeConfig = {}): WorktreeResult {
	const canonicalGitRoot = findGitRoot(gitRoot);
	if (!canonicalGitRoot) {
		throw new Error(`Not a git repository: ${gitRoot}`);
	}

	const dir = worktreesDir(canonicalGitRoot);
	mkdirSync(dir, { recursive: true });

	const rawWorktreePath = join(dir, slug);
	const branch = worktreeBranchName(slug);
	const headCommit = git(["rev-parse", "HEAD"], canonicalGitRoot);

	if (!existsSync(rawWorktreePath)) {
		gitMaybe(["worktree", "prune"], canonicalGitRoot);
	}
	git(["worktree", "add", "-B", branch, rawWorktreePath, "HEAD"], canonicalGitRoot);

	const worktreePath = realpathSync(rawWorktreePath);
	if (config.symlinkDirs) {
		symlinkDirectories(canonicalGitRoot, worktreePath, config.symlinkDirs);
	}

	return { worktreePath, branch, headCommit, gitRoot: canonicalGitRoot };
}

export function hasWorktreeChanges(worktreePath: string, headCommit: string): boolean {
	const status = spawnSync("git", ["status", "--porcelain"], {
		cwd: worktreePath,
		encoding: "utf-8",
	});
	if (status.status !== 0) return true;
	if (status.stdout.trim().length > 0) return true;

	const revList = spawnSync("git", ["rev-list", "--count", `${headCommit}..HEAD`], {
		cwd: worktreePath,
		encoding: "utf-8",
	});
	if (revList.status !== 0) return true;

	const newCommitCount = Number.parseInt(revList.stdout.trim(), 10);
	return Number.isFinite(newCommitCount) && newCommitCount > 0;
}

export function removeWorktree(worktreePath: string, branch: string, gitRoot: string): boolean {
	const canonicalGitRoot = findGitRoot(gitRoot) ?? gitRoot;
	const result = spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
		cwd: canonicalGitRoot,
		encoding: "utf-8",
	});
	if (result.status !== 0) return false;

	const branchDelete = spawnSync("git", ["branch", "-D", branch], {
		cwd: canonicalGitRoot,
		encoding: "utf-8",
	});
	return branchDelete.status === 0 || branchDelete.stderr.includes("not found");
}

export function symlinkDirectories(gitRoot: string, worktreePath: string, dirs: string[]): void {
	for (const dir of dirs) {
		const src = join(gitRoot, dir);
		const dest = join(worktreePath, dir);
		if (!existsSync(src) || existsSync(dest)) continue;

		try {
			symlinkSync(src, dest, "dir");
		} catch {
			// Missing or already-created optimization links should not fail worktree creation.
		}
	}
}

function isEphemeralSlug(slug: string): boolean {
	return /^agent-\d+(?:-.+)?$/.test(slug) || /^task-\d+(?:-.+)?$/.test(slug);
}

function getCleanupBaseCommit(gitRoot: string, branch: string): string | null {
	return gitMaybe(["merge-base", "HEAD", branch], gitRoot);
}

export function cleanupStaleWorktrees(gitRoot: string, maxAgeDays: number): number {
	const canonicalGitRoot = findGitRoot(gitRoot);
	if (!canonicalGitRoot) return 0;

	const dir = worktreesDir(canonicalGitRoot);
	if (!existsSync(dir)) return 0;

	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	let removed = 0;

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (!isEphemeralSlug(entry.name)) continue;

		const worktreePath = join(dir, entry.name);
		let mtimeMs: number;
		try {
			mtimeMs = lstatSync(worktreePath).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs > cutoff) continue;

		const branch = worktreeBranchName(entry.name);
		const baseCommit = getCleanupBaseCommit(canonicalGitRoot, branch);
		if (!baseCommit) continue;
		if (hasWorktreeChanges(worktreePath, baseCommit)) continue;
		if (removeWorktree(worktreePath, branch, canonicalGitRoot)) removed++;
		else if (!existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
	}

	return removed;
}
