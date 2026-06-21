import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	cleanupStaleWorktrees,
	createWorktree,
	findGitRoot,
	hasWorktreeChanges,
	removeWorktree,
	symlinkDirectories,
} from "../worktree.ts";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function initRepo(dir: string): void {
	git(["init", "--initial-branch=main"], dir);
	git(["config", "--local", "user.email", "test@example.com"], dir);
	git(["config", "--local", "user.name", "Test User"], dir);
	git(["config", "--local", "core.hooksPath", "/dev/null"], dir);
	writeFileSync(join(dir, "README.md"), "# smoke\n");
	git(["add", "README.md"], dir);
	git(["commit", "-m", "initial"], dir);
}

function createCommit(dir: string, file: string, content: string, message: string): string {
	writeFileSync(join(dir, file), content);
	git(["add", file], dir);
	git(["commit", "-m", message], dir);
	return git(["rev-parse", "HEAD"], dir);
}

function getBranch(dir: string): string {
	return git(["symbolic-ref", "--short", "HEAD"], dir);
}

function getStatus(dir: string): string {
	return git(["status", "--porcelain"], dir);
}

function makeOld(path: string): void {
	const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
	utimesSync(path, old, old);
}

let tempDir = "";
let repoDir = "";

beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-worktree-extension-test-")));
	repoDir = join(tempDir, "repo");
	mkdirSync(repoDir);
	initRepo(repoDir);
});

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("findGitRoot", () => {
	it("finds the repository root from nested directories", () => {
		const nested = join(repoDir, "src", "nested");
		mkdirSync(nested, { recursive: true });

		assert.equal(findGitRoot(nested), repoDir);
	});

	it("returns the canonical repository root from inside a worktree", () => {
		const worktree = createWorktree(repoDir, "root-check");

		assert.equal(findGitRoot(worktree.worktreePath), repoDir);
	});
});

describe("worktree lifecycle", () => {
	it("creates a worktree branch from the current HEAD under .pi/worktrees", () => {
		const head = git(["rev-parse", "HEAD"], repoDir);
		const worktree = createWorktree(repoDir, "task-0");

		assert.equal(existsSync(worktree.worktreePath), true);
		assert.equal(worktree.worktreePath, join(repoDir, ".pi", "worktrees", "task-0"));
		assert.equal(worktree.branch, "pi-worktree-task-0");
		assert.equal(worktree.headCommit, head);
		assert.equal(getBranch(worktree.worktreePath), "pi-worktree-task-0");
		assert.equal(git(["rev-parse", "HEAD"], worktree.worktreePath), head);
	});

	it("keeps parallel edits isolated from each other and from main", () => {
		createCommit(repoDir, "shared.txt", "original", "add shared");

		const first = createWorktree(repoDir, "task-1");
		const second = createWorktree(repoDir, "task-2");
		writeFileSync(join(first.worktreePath, "shared.txt"), "first");
		writeFileSync(join(second.worktreePath, "shared.txt"), "second");

		assert.equal(readFileSync(join(first.worktreePath, "shared.txt"), "utf-8"), "first");
		assert.equal(readFileSync(join(second.worktreePath, "shared.txt"), "utf-8"), "second");
		assert.equal(readFileSync(join(repoDir, "shared.txt"), "utf-8"), "original");
		assert.match(getStatus(first.worktreePath), /shared\.txt/);
		assert.match(getStatus(second.worktreePath), /shared\.txt/);
	});

	it("detects dirty files, untracked files, and new commits", () => {
		createCommit(repoDir, "tracked.txt", "original", "add tracked");

		const dirty = createWorktree(repoDir, "task-dirty");
		writeFileSync(join(dirty.worktreePath, "tracked.txt"), "dirty");
		assert.equal(hasWorktreeChanges(dirty.worktreePath, dirty.headCommit), true);

		const untracked = createWorktree(repoDir, "task-untracked");
		writeFileSync(join(untracked.worktreePath, "new.txt"), "new");
		assert.equal(hasWorktreeChanges(untracked.worktreePath, untracked.headCommit), true);

		const committed = createWorktree(repoDir, "task-commit");
		createCommit(committed.worktreePath, "committed.txt", "committed", "new work");
		assert.equal(hasWorktreeChanges(committed.worktreePath, committed.headCommit), true);
	});

	it("removes clean worktrees and their branches", () => {
		const worktree = createWorktree(repoDir, "task-clean");

		assert.equal(hasWorktreeChanges(worktree.worktreePath, worktree.headCommit), false);
		assert.equal(removeWorktree(worktree.worktreePath, worktree.branch, worktree.gitRoot), true);
		assert.equal(existsSync(worktree.worktreePath), false);
		assert.equal(git(["branch", "--list", worktree.branch], repoDir), "");
	});
});

describe("worktree optimizations and cleanup", () => {
	it("symlinks requested directories without overwriting existing paths", () => {
		const nodeModules = join(repoDir, "node_modules");
		mkdirSync(nodeModules);
		writeFileSync(join(nodeModules, "marker.txt"), "source");

		const worktree = createWorktree(repoDir, "task-symlink");
		symlinkDirectories(repoDir, worktree.worktreePath, ["node_modules"]);
		const symlinkPath = join(worktree.worktreePath, "node_modules");

		assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
		assert.equal(readFileSync(join(symlinkPath, "marker.txt"), "utf-8"), "source");

		const existing = createWorktree(repoDir, "task-existing");
		mkdirSync(join(existing.worktreePath, "custom"));
		symlinkSync(nodeModules, join(existing.worktreePath, "custom", "link"), "dir");
		symlinkDirectories(repoDir, existing.worktreePath, ["custom"]);
		assert.equal(lstatSync(join(existing.worktreePath, "custom")).isDirectory(), true);
	});

	it("cleans old clean ephemeral worktrees and preserves changed or user-named worktrees", () => {
		const clean = createWorktree(repoDir, "task-0-old");
		const changed = createWorktree(repoDir, "task-1-old");
		const userNamed = createWorktree(repoDir, "user-named");

		writeFileSync(join(changed.worktreePath, "keep.txt"), "important");
		for (const path of [clean.worktreePath, changed.worktreePath, userNamed.worktreePath]) {
			makeOld(path);
		}

		assert.equal(cleanupStaleWorktrees(repoDir, 1), 1);
		assert.equal(existsSync(clean.worktreePath), false);
		assert.equal(existsSync(changed.worktreePath), true);
		assert.equal(existsSync(userNamed.worktreePath), true);
		assert.equal(basename(changed.worktreePath), "task-1-old");
	});
});
