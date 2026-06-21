/**
 * Worktree Isolation Extension
 *
 * Adds an isolated-subagent tool that runs parallel subagent tasks in separate
 * git worktrees so file edits, staging, and commits do not collide.
 */

import { basename } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	mapWithConcurrencyLimit,
	runSingleAgent,
	type SingleResult,
	type SubagentDetails,
	truncateParallelOutput,
} from "./subagents.ts";
import {
	createWorktree,
	findGitRoot,
	hasWorktreeChanges,
	removeWorktree,
	type WorktreeConfig,
	type WorktreeResult,
} from "./worktree.ts";

type IsolationMode = "auto" | "worktree" | "none";

interface KeptWorktree {
	slug: string;
	branch: string;
	path: string;
	reason: "changed" | "cleanup-failed";
}

interface IsolatedSubagentDetails extends SubagentDetails {
	gitRoot: string | null;
	keptWorktrees: KeptWorktree[];
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["package", "user", "project", "both", "all"] as const, {
	description:
		'Which agent directories to use. Default: "package" for bundled agents. Use "all" to include package, user, and project agents.',
	default: "package",
});

const IsolationModeSchema = StringEnum(["auto", "worktree", "none"] as const, {
	description:
		'Isolation behavior. "auto" isolates parallel tasks in git repos, "worktree" also isolates single mode, "none" disables worktree isolation.',
	default: "auto",
});

const IsolatedSubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	isolation: Type.Optional(IsolationModeSchema),
	symlinkDirs: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Directories to symlink from the main repo into each worktree. Default: ["node_modules"].',
		}),
	),
});

type IsolatedSubagentParamsValue = Static<typeof IsolatedSubagentParams>;

function makeSlug(prefix: string, index?: number): string {
	const parts = [prefix];
	if (index !== undefined) parts.push(String(index));
	parts.push(Date.now().toString(36));
	parts.push(Math.random().toString(36).slice(2, 8));
	return parts.join("-");
}

function makeDetails(
	mode: SubagentDetails["mode"],
	agentScope: AgentScope,
	projectAgentsDir: string | null,
	gitRoot: string | null,
	keptWorktrees: KeptWorktree[],
	results: SingleResult[],
): IsolatedSubagentDetails {
	return {
		mode,
		agentScope,
		projectAgentsDir,
		results,
		gitRoot,
		keptWorktrees,
	};
}

function wrapUpdate(
	onUpdate: ((partial: AgentToolResult<IsolatedSubagentDetails>) => void) | undefined,
	makeCurrentDetails: (results: SingleResult[]) => IsolatedSubagentDetails,
) {
	if (!onUpdate) return undefined;
	return (partial: AgentToolResult<SubagentDetails>) => {
		onUpdate({
			...partial,
			details: makeCurrentDetails(partial.details?.results ?? []),
		});
	};
}

function formatKeptWorktrees(keptWorktrees: KeptWorktree[]): string {
	if (keptWorktrees.length === 0) return "";

	const lines = ["", "Kept worktrees:"];
	for (const kept of keptWorktrees) {
		const reason = kept.reason === "changed" ? "has changes" : "cleanup failed";
		lines.push(`- ${kept.slug}: ${kept.branch} (${reason}) at ${kept.path}`);
	}
	return lines.join("\n");
}

function cleanupWorktrees(worktrees: WorktreeResult[]): KeptWorktree[] {
	const kept: KeptWorktree[] = [];

	for (const wt of worktrees) {
		if (hasWorktreeChanges(wt.worktreePath, wt.headCommit)) {
			kept.push({
				slug: basename(wt.worktreePath),
				branch: wt.branch,
				path: wt.worktreePath,
				reason: "changed",
			});
			continue;
		}

		if (!removeWorktree(wt.worktreePath, wt.branch, wt.gitRoot)) {
			kept.push({
				slug: basename(wt.worktreePath),
				branch: wt.branch,
				path: wt.worktreePath,
				reason: "cleanup-failed",
			});
		}
	}

	return kept;
}

async function confirmProjectAgentsIfNeeded(
	params: IsolatedSubagentParamsValue,
	agents: AgentConfig[],
	projectAgentsDir: string | null,
	agentScope: AgentScope,
	ctx: ExtensionContext,
): Promise<boolean> {
	const confirmProjectAgents = params.confirmProjectAgents ?? true;
	if (agentScope !== "project" && agentScope !== "both" && agentScope !== "all") return true;
	if (!confirmProjectAgents || !ctx.hasUI) return true;

	const requestedAgentNames = new Set<string>();
	if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
	if (params.tasks) for (const task of params.tasks) requestedAgentNames.add(task.agent);
	if (params.agent) requestedAgentNames.add(params.agent);

	const projectAgentsRequested = Array.from(requestedAgentNames)
		.map((name) => agents.find((agent) => agent.name === name))
		.filter((agent): agent is AgentConfig => agent?.source === "project");

	if (projectAgentsRequested.length === 0) return true;

	const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
	const dir = projectAgentsDir ?? "(unknown)";
	return ctx.ui.confirm(
		"Run project-local agents?",
		`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
	);
}

function worktreeConfig(params: IsolatedSubagentParamsValue): WorktreeConfig {
	return { symlinkDirs: params.symlinkDirs ?? ["node_modules"] };
}

const isolatedSubagentTool = defineTool({
	name: "isolated-subagent",
	label: "Isolated Subagent",
	description: [
		"Delegate tasks to specialized subagents with git worktree isolation.",
		"Parallel tasks run in separate working copies so edits, staging, commits, and deletes cannot collide.",
		"Outside git repositories, it falls back to normal subagent execution.",
	].join(" "),
	promptSnippet: "Delegate tasks to subagents with git worktree isolation for parallel file edits",
	promptGuidelines: [
		"When running parallel tasks that edit files, use isolated-subagent instead of subagent to prevent file conflicts.",
		"For single read-only tasks, plain subagent is usually fine because no worktree isolation is needed.",
		"When isolated-subagent keeps a worktree, tell the user the branch name so they can inspect or merge it.",
	],
	parameters: IsolatedSubagentParams,

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const agentScope: AgentScope = params.agentScope ?? "package";
		const discovery = discoverAgents(ctx.cwd, agentScope);
		const agents = discovery.agents;
		const isolation: IsolationMode = params.isolation ?? "auto";
		const gitRoot = isolation === "none" ? null : findGitRoot(ctx.cwd);
		let keptWorktrees: KeptWorktree[] = [];

		const hasChain = (params.chain?.length ?? 0) > 0;
		const hasTasks = (params.tasks?.length ?? 0) > 0;
		const hasSingle = Boolean(params.agent && params.task);
		const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
		const mode: SubagentDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";
		const makeCurrentDetails = (results: SingleResult[]) =>
			makeDetails(mode, agentScope, discovery.projectAgentsDir, gitRoot, keptWorktrees, results);

		if (modeCount !== 1) {
			const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
					},
				],
				details: makeCurrentDetails([]),
			};
		}

		const projectAgentsApproved = await confirmProjectAgentsIfNeeded(
			params,
			agents,
			discovery.projectAgentsDir,
			agentScope,
			ctx,
		);
		if (!projectAgentsApproved) {
			return {
				content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
				details: makeCurrentDetails([]),
			};
		}

		if (params.chain && params.chain.length > 0) {
			const results: SingleResult[] = [];
			let previousOutput = "";

			for (let i = 0; i < params.chain.length; i++) {
				const step = params.chain[i];
				const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
				const chainUpdate = onUpdate
					? (partial: AgentToolResult<SubagentDetails>) => {
							const currentResult = partial.details?.results[0];
							if (!currentResult) return;
							onUpdate({
								...partial,
								details: makeCurrentDetails([...results, currentResult]),
							});
						}
					: undefined;

				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					step.agent,
					taskWithContext,
					step.cwd,
					i + 1,
					signal,
					chainUpdate,
					(resultsForDetails) =>
						makeDetails(
							"chain",
							agentScope,
							discovery.projectAgentsDir,
							gitRoot,
							keptWorktrees,
							resultsForDetails,
						),
				);
				results.push(result);

				if (isFailedResult(result)) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
						details: makeCurrentDetails(results),
						isError: true,
					};
				}
				previousOutput = getFinalOutput(result.messages);
			}

			return {
				content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
				details: makeCurrentDetails(results),
			};
		}

		if (params.tasks && params.tasks.length > 0) {
			if (params.tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [
						{
							type: "text",
							text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						},
					],
					details: makeCurrentDetails([]),
				};
			}

			const allResults: SingleResult[] = new Array(params.tasks.length);
			for (let i = 0; i < params.tasks.length; i++) {
				allResults[i] = {
					agent: params.tasks[i].agent,
					agentSource: "unknown",
					task: params.tasks[i].task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
				};
			}

			const emitParallelUpdate = () => {
				if (!onUpdate) return;
				const running = allResults.filter((result) => result.exitCode === -1).length;
				const done = allResults.filter((result) => result.exitCode !== -1).length;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
					details: makeCurrentDetails([...allResults]),
				});
			};

			const useWorktrees = Boolean(gitRoot);
			const worktrees = gitRoot
				? params.tasks.map((_, index) => createWorktree(gitRoot, makeSlug("task", index), worktreeConfig(params)))
				: [];

			try {
				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
					const isolatedCwd = worktrees[index]?.worktreePath;
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						task.agent,
						task.task,
						isolatedCwd ?? task.cwd,
						undefined,
						signal,
						(partial) => {
							if (!partial.details?.results[0]) return;
							allResults[index] = partial.details.results[0];
							emitParallelUpdate();
						},
						(resultsForDetails) =>
							makeDetails(
								"parallel",
								agentScope,
								discovery.projectAgentsDir,
								gitRoot,
								keptWorktrees,
								resultsForDetails,
							),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				keptWorktrees = cleanupWorktrees(worktrees);

				const successCount = results.filter((result) => !isFailedResult(result)).length;
				const summaries = results.map((result) => {
					const output = truncateParallelOutput(getResultOutput(result));
					const status = isFailedResult(result)
						? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
						: "completed";
					return `### [${result.agent}] ${status}\n\n${output}`;
				});

				const fallbackNote = useWorktrees
					? ""
					: isolation === "none"
						? "\n\nWorktree isolation disabled; ran without worktree isolation."
						: "\n\nNo git repository found; ran without worktree isolation.";
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded${fallbackNote}\n\n${summaries.join(
								"\n\n---\n\n",
							)}${formatKeptWorktrees(keptWorktrees)}`,
						},
					],
					details: makeCurrentDetails(results),
				};
			} catch (error) {
				keptWorktrees = cleanupWorktrees(worktrees);
				throw error;
			}
		}

		if (params.agent && params.task) {
			let worktree: WorktreeResult | null = null;
			if (isolation === "worktree" && gitRoot) {
				worktree = createWorktree(gitRoot, makeSlug("single"), worktreeConfig(params));
			}

			try {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					worktree?.worktreePath ?? params.cwd,
					undefined,
					signal,
					wrapUpdate(onUpdate, (results) =>
						makeDetails("single", agentScope, discovery.projectAgentsDir, gitRoot, keptWorktrees, results),
					),
					(resultsForDetails) =>
						makeDetails(
							"single",
							agentScope,
							discovery.projectAgentsDir,
							gitRoot,
							keptWorktrees,
							resultsForDetails,
						),
				);

				keptWorktrees = cleanupWorktrees(worktree ? [worktree] : []);
				if (isFailedResult(result)) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${formatKeptWorktrees(keptWorktrees)}`,
							},
						],
						details: makeCurrentDetails([result]),
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `${getFinalOutput(result.messages) || "(no output)"}${formatKeptWorktrees(keptWorktrees)}`,
						},
					],
					details: makeCurrentDetails([result]),
				};
			} catch (error) {
				keptWorktrees = cleanupWorktrees(worktree ? [worktree] : []);
				throw error;
			}
		}

		const available = agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
		return {
			content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
			details: makeCurrentDetails([]),
		};
	},

	renderCall(args, theme) {
		const scope: AgentScope = args.agentScope ?? "package";
		if (args.tasks && args.tasks.length > 0) {
			let text =
				theme.fg("toolTitle", theme.bold("isolated-subagent ")) +
				theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
				theme.fg("muted", ` [${scope}]`);
			for (const task of args.tasks.slice(0, 3)) {
				const preview = task.task.length > 40 ? `${task.task.slice(0, 40)}...` : task.task;
				text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${preview}`)}`;
			}
			if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
			return new Text(text, 0, 0);
		}

		const agentName = args.agent || args.chain?.[0]?.agent || "...";
		const previewSource = args.task || args.chain?.[0]?.task || "...";
		const preview = previewSource.length > 60 ? `${previewSource.slice(0, 60)}...` : previewSource;
		return new Text(
			theme.fg("toolTitle", theme.bold("isolated-subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`) +
				`\n  ${theme.fg("dim", preview)}`,
			0,
			0,
		);
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(isolatedSubagentTool);
}
