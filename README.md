# Pi Worktree Isolation Extension

Adds an `isolated-subagent` tool to Pi. Parallel coding-agent tasks run in separate git worktrees so edits, staging, deletes, and commits do not collide.

When a prompt asks for multiple workers, each task gets its own branch and working directory under `.pi/worktrees/`. Clean worktrees are removed automatically. Worktrees with uncommitted changes or new commits are preserved and reported so you can inspect, merge, or discard the result.

## Why

Worktree isolation is a useful pattern for parallel coding agents. This project is inspired by worktree-isolated agent workflows popularized by tools like Claude Code, but it is an independent Pi extension and does not include or depend on Claude Code.

## Install

From GitHub:

```bash
pi install git:github.com/yan-xie-nk/pi-extension-worktree-isolation@v0.1.0
```

For a one-off trial without changing settings:

```bash
pi -e git:github.com/yan-xie-nk/pi-extension-worktree-isolation@v0.1.0
```

For local development from this directory:

```bash
pi -e /absolute/path/to/pi-extension-worktree-isolation
```

## Usage

Ask Pi to use `isolated-subagent` for parallel tasks that may edit files:

```text
Use isolated-subagent with two parallel worker tasks:
1. Add a unit test for the parser error path.
2. Update the parser docs for that error path.
```

Parallel mode creates one worktree per task under:

```text
.pi/worktrees/<slug>
```

Branches are named:

```text
pi-worktree-<slug>
```

Clean worktrees are removed automatically. Worktrees with uncommitted changes or new commits are kept and reported in the tool result.

Single-agent mode is not isolated by default. Opt in explicitly:

```text
Use isolated-subagent with worker to prototype the formatter fix, with isolation set to worktree.
```

## Agent Scopes

This package includes bundled sample agents: `worker`, `scout`, `planner`, and `reviewer`.

`agentScope` controls where agents are loaded from:

| Scope | Agents |
|-------|--------|
| `package` | Bundled agents from this package. Default. |
| `user` | `~/.pi/agent/agents/*.md` |
| `project` | nearest `.pi/agents/*.md` |
| `both` | user + project agents |
| `all` | package + user + project agents |

Project-local agents are repo-controlled. When UI is available, this extension asks for confirmation before running them unless `confirmProjectAgents` is `false`.

## Parameters

| Parameter | Description |
|-----------|-------------|
| `tasks` | Parallel tasks. Each task has `agent`, `task`, and optional `cwd`. |
| `agent` / `task` | Single-agent mode. |
| `chain` | Sequential subagent mode. Chain mode currently runs without worktree isolation. |
| `agentScope` | `"package"`, `"user"`, `"project"`, `"both"`, or `"all"`. Defaults to `"package"`. |
| `confirmProjectAgents` | Prompt before running project-local agents. Defaults to `true`. |
| `isolation` | `"auto"`, `"worktree"`, or `"none"`. Defaults to `"auto"`. |
| `symlinkDirs` | Directories to symlink from the main repo into each worktree. Defaults to `["node_modules"]`. |

## Safety Model

- Git commands are executed with argument arrays and `shell: false`.
- Worktrees are created only inside the repository's `.pi/worktrees/` directory.
- Cleanup removes only worktrees that this extension created and only after checking for changes.
- Change detection fails closed: if git status checks fail, the worktree is kept.
- Project-local agents require confirmation by default.
- Subagent system prompts are written to temporary files with `0600` permissions and removed after execution.

## Local Smoke Test

```bash
mkdir -p /tmp/pi-worktree-smoke
cd /tmp/pi-worktree-smoke
git init
git config user.email test@example.com
git config user.name Test
echo "base" > README.md
git add README.md
git commit -m init
pi -e /path/to/pi-extension-worktree-isolation
```

```text
Use isolated-subagent with two parallel worker tasks:
1. Create agent-one.txt with "one".
2. Create agent-two.txt with "two".
```

```bash
git status --short
git worktree list
git branch --list 'pi-worktree-*'
ls .pi/worktrees
```

## Development

```bash
npm run check
npm test
npm run pack:dry
npm run verify
```

The public repo includes standalone tests for package metadata and git worktree lifecycle behavior.

## Contribution Policy

This repo is public for installation, auditability, and reference. It is not accepting external contributions, feature requests, support requests, or unsolicited pull requests.
