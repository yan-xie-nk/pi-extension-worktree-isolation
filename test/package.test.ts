import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe("package metadata", () => {
	it("declares a Pi extension package manifest", () => {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
			files?: string[];
			keywords?: string[];
			pi?: { extensions?: string[] };
			peerDependencies?: Record<string, string>;
			scripts?: Record<string, string>;
		};

		assert.equal(manifest.keywords?.includes("pi-package"), true);
		assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
		assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
		assert.equal(manifest.peerDependencies?.typebox, "*");
		assert.equal(manifest.scripts?.test, "node --test test/*.test.ts");
	});

	it("publishes only runtime extension files", () => {
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
			files?: string[];
		};

		assert.deepEqual(manifest.files, [
			"README.md",
			"LICENSE",
			"index.ts",
			"subagents.ts",
			"worktree.ts",
			"agents/*.md",
		]);
		assert.equal(
			manifest.files?.some((file) => file.startsWith("test/")),
			false,
		);
		assert.equal(
			manifest.files?.some((file) => file.startsWith(".github/")),
			false,
		);
		assert.equal(manifest.files?.includes("package-lock.json"), false);
	});

	it("is self-contained for GitHub installation", () => {
		const indexSource = readFileSync(join(packageRoot, "index.ts"), "utf-8");
		const subagentsSource = readFileSync(join(packageRoot, "subagents.ts"), "utf-8");
		const readmeSource = readFileSync(join(packageRoot, "README.md"), "utf-8");

		assert.equal(indexSource.includes("../subagent"), false);
		assert.equal(subagentsSource.includes("../subagent"), false);
		assert.equal(readmeSource.includes("YOUR_GITHUB_USERNAME"), false);
		assert.equal(readmeSource.includes("yan-xie-nk/pi-extension-worktree-isolation"), true);
		assert.equal(existsSync(join(packageRoot, "agents", "worker.md")), true);
	});
});
