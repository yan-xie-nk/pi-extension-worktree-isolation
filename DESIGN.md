# Worktree Isolation Extension for Pi

## Problem

Pi's subagent extension spawns child `pi` processes that all share the same working directory. When running parallel tasks, agents stomp on each other's file edits, git staging, and commits. Claude Code solves this with ~1000 lines of deeply integrated worktree management. Pi has zero worktree support.

## Definition of Success

45 tests in `packages/coding-agent/test/worktree-isolation.test.ts` define success across 10 categories:

| Category | Tests | Core assertion |
|----------|-------|----------------|
| Worktree creation | 7 | Creates `.pi/worktrees/<slug>` with unique branch from HEAD |
| Change detection | 5 | Detects dirty trees/new commits; no false positives on clean |
| Worktree removal | 4 | Removes dir + branch; git recognizes removal |
| **Parallel isolation** | **6** | **Edits, staging, status, pwd, deletes are all independent** |
| Symlink optimization | 4 | Symlinks node_modules to avoid disk bloat |
| Conditional cleanup | 3 | Discard clean worktrees; keep changed ones with branch name |
| Error handling | 4 | Fail-closed on non-git, missing paths, invalid state |
| Full workflow | 4 | 3 agents → selective cleanup → merge back |
| Stale cleanup | 3 | Pattern-match ephemeral slugs; preserve unpushed work |
| Edge cases | 6 | Dirty main, rebase, concurrent ops, nested worktrees |

The **single most important test**: two agents edit the same file in parallel — each sees only their own version, main repo is untouched.

## Architecture Decision

**Extension, not core change.** Pi's architecture is extension-driven. The worktree logic lives as a standalone extension that wraps/enhances the existing subagent extension's parallel mode.

## Implementation Plan

### File Structure

```
packages/coding-agent/examples/extensions/worktree-isolation/
├── DESIGN.md          # This file
├── index.ts           # Extension entry point (registers the tool)
├── worktree.ts        # Git worktree lifecycle (create, detect changes, remove)
└── README.md          # Usage docs
```

### Module: `worktree.ts` — Git Worktree Lifecycle

```ts
// Core types
interface WorktreeResult {
  worktreePath: string;
  branch: string;
  headCommit: string;
  gitRoot: string;
}

interface WorktreeConfig {
  symlinkDirs?: string[];  // e.g. ["node_modules", ".turbo"]
}
```

**Functions to implement:**

1. **`findGitRoot(cwd: string): string | null`**
   - Walk up from cwd looking for `.git` (dir or file)
   - If `.git` is a file (already in a worktree), follow `gitdir:` pointer and resolve `commondir` to find the canonical root
   - Prevents nested worktrees (always creates from the real repo root)

2. **`createWorktree(gitRoot: string, slug: string, config?: WorktreeConfig): WorktreeResult`**
   - `mkdir -p <gitRoot>/.pi/worktrees/`
   - `git worktree add -B pi-worktree-<slug> .pi/worktrees/<slug> HEAD`
   - `-B` (not `-b`) handles orphan branches from prior crashed runs
   - Record `headCommit` via `git rev-parse HEAD`
   - Optionally symlink dirs from `config.symlinkDirs`
   - Return `{ worktreePath, branch, headCommit, gitRoot }`

3. **`hasWorktreeChanges(worktreePath: string, headCommit: string): boolean`**
   - `git status --porcelain` — any output = dirty
   - `git rev-list --count <headCommit>..HEAD` — >0 = new commits
   - Fail-closed: if either command errors, return `true` (don't delete unknown state)

4. **`removeWorktree(worktreePath: string, branch: string, gitRoot: string): boolean`**
   - `git worktree remove --force <path>` (from gitRoot as cwd)
   - `git branch -D <branch>`
   - Return success/failure

5. **`symlinkDirectories(gitRoot: string, worktreePath: string, dirs: string[]): void`**
   - For each dir: if source exists and dest doesn't, `symlink(src, dest, 'dir')`
   - Skip silently on ENOENT (source missing) or EEXIST (already there)

6. **`cleanupStaleWorktrees(gitRoot: string, maxAgeDays: number): number`**
   - Read `.pi/worktrees/` entries
   - Filter by ephemeral slug pattern (`/^agent-\d+$/`, `/^task-\d+$/`)
   - Check mtime; skip if newer than cutoff
   - Only remove if `hasWorktreeChanges` returns false
   - Return count removed

### Module: `index.ts` — Extension Entry Point

The extension registers a tool called `"isolated-subagent"` (or patches the existing subagent's parallel mode). Two approaches:

**Option A: New tool** (simpler, no monkey-patching)

Registers an `isolated-subagent` tool that wraps the existing subagent flow:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "isolated-subagent",
    label: "Isolated Subagent",
    description: "Delegate tasks to subagents with git worktree isolation. Each parallel task gets its own working copy.",
    parameters: /* same as subagent but with added isolation field */,

    async execute(_id, params, signal, onUpdate, ctx) {
      const gitRoot = findGitRoot(ctx.cwd);
      if (!gitRoot) {
        // Fall back to non-isolated mode
        return runWithoutIsolation(params, ctx, signal, onUpdate);
      }

      const config: WorktreeConfig = {
        symlinkDirs: ["node_modules"],
      };

      // For parallel mode: create a worktree per task
      if (params.tasks?.length) {
        const worktrees = params.tasks.map((_, i) =>
          createWorktree(gitRoot, `task-${i}-${Date.now().toString(36)}`, config)
        );

        try {
          // Run each subagent with its own worktree as cwd
          const results = await mapWithConcurrencyLimit(
            params.tasks,
            MAX_CONCURRENCY,
            async (task, index) => {
              return runSingleAgent(
                worktrees[index].worktreePath, // <-- isolated cwd
                agents,
                task.agent,
                task.task,
                worktrees[index].worktreePath,
                ...
              );
            }
          );

          // Cleanup: remove worktrees with no changes, keep the rest
          const kept: Array<{ slug: string; branch: string; path: string }> = [];
          for (const wt of worktrees) {
            if (hasWorktreeChanges(wt.worktreePath, wt.headCommit)) {
              kept.push({ slug: basename(wt.worktreePath), branch: wt.branch, path: wt.worktreePath });
            } else {
              removeWorktree(wt.worktreePath, wt.branch, wt.gitRoot);
            }
          }

          // Report results + surviving worktree branches
          return formatResults(results, kept);
        } catch (err) {
          // On abort/error, still clean up empty worktrees
          for (const wt of worktrees) {
            if (!hasWorktreeChanges(wt.worktreePath, wt.headCommit)) {
              removeWorktree(wt.worktreePath, wt.branch, wt.gitRoot);
            }
          }
          throw err;
        }
      }

      // For single mode: optionally isolate if params.isolation === "worktree"
      if (params.isolation === "worktree") {
        const wt = createWorktree(gitRoot, `single-${Date.now().toString(36)}`, config);
        const result = await runSingleAgent(wt.worktreePath, ...);
        // Cleanup or keep
        if (!hasWorktreeChanges(wt.worktreePath, wt.headCommit)) {
          removeWorktree(wt.worktreePath, wt.branch, wt.gitRoot);
        }
        return result;
      }

      // Non-isolated single mode: same as before
      return runSingleAgent(ctx.cwd, ...);
    }
  });
}
```

**Option B: Patch subagent's parallel mode** (transparent, but fragile)

Hook into the subagent extension's `runSingleAgent` calls by providing a cwd override. Less code but couples to subagent internals.

**Recommendation: Option A.** Clean separation. The LLM chooses `isolated-subagent` when it needs parallel isolation (or the system prompt guides it). No fragile monkey-patching.

### How It Integrates With the Subagent Extension

The `isolated-subagent` tool reuses the same agent discovery (`discoverAgents`), the same `runSingleAgent` function, and the same rendering. The only difference is:

1. Before spawning child processes, it creates a worktree per parallel task
2. It passes `wt.worktreePath` as the `cwd` parameter to each child
3. After completion, it conditionally cleans up or reports kept branches

The existing subagent extension stays unchanged — this is additive.

### System Prompt Addition

The tool's `promptGuidelines` injects:

```
- When running parallel tasks that edit files, use `isolated-subagent` instead of `subagent` to prevent file conflicts.
- For single read-only tasks (grep, find, analysis), plain `subagent` is fine — no isolation needed.
- When a worktree is kept (has changes), the result includes the branch name. Tell the user to merge it.
```

### Configuration

Via the extension's settings or a `.pi/config.json` field:

```json
{
  "worktreeIsolation": {
    "symlinkDirs": ["node_modules", ".turbo", "dist"],
    "autoCleanupDays": 7,
    "alwaysIsolateParallel": true
  }
}
```

If `alwaysIsolateParallel: true`, the standard `subagent` tool's parallel mode auto-creates worktrees (Option B behavior without monkey-patching — instead the subagent extension checks for the config and calls worktree functions directly).

## Key Differences from Claude Code

| Aspect | Claude Code | Pi Extension |
|--------|-------------|--------------|
| Integration depth | Core (tools, session, cleanup, tmux) | Extension (opt-in, additive) |
| Worktree location | `.claude/worktrees/` | `.pi/worktrees/` |
| Branch naming | `worktree-<slug>` | `pi-worktree-<slug>` |
| Sparse checkout | Supported via settings | Not needed (small repos typical for pi) |
| Hook-based VCS | Supported (non-git) | Not supported (git-only) |
| Stale cleanup | Periodic with pattern matching | On-demand or configurable interval |
| tmux integration | Deep (--worktree --tmux) | None (pi doesn't have tmux mode) |
| Lines of code | ~1000 | ~200 estimated |

## Implementation Order

1. `worktree.ts` — pure git operations, no pi dependencies, testable standalone
2. Verify with the existing 45 tests (they already inline the same logic)
3. `index.ts` — extension registration, wires worktree lifecycle into subagent flow
4. Test end-to-end with real `pi` subagent invocations
5. Add `promptGuidelines` so the LLM knows when to use it
6. Optional: config-driven auto-isolation for parallel mode

## Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Git lock contention | Parallel worktree creates could hit `.git/index.lock` | Git worktrees use separate index files per worktree — no contention |
| Disk bloat | Many worktrees = many copies | Symlink `node_modules`; auto-cleanup stale worktrees |
| Orphaned worktrees on crash | Disk leaks | Stale cleanup on next run (mtime-based) |
| Non-git repos | Extension fails | Graceful fallback to non-isolated mode |
| macOS path resolution | `/var` vs `/private/var` | Always `realpathSync` worktree paths |
