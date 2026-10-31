import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubForge } from "../../../src/adapters/forge/index.ts";
import {
  applyPatch,
  FIX_PATCH,
  type ProjectFile,
  patchFile,
  projectFiles,
} from "../../../tools/demo/project.ts";
import { demoRuleset } from "../../../tools/demo/ruleset.ts";
import { runScenario } from "../../../tools/demo/scenario.ts";
import {
  type AppCredentials,
  githubDemoSide,
} from "../../../tools/demo/side.ts";
import {
  GitHubSimulator,
  type SimulatedApp,
} from "../../forge/github/simulator.ts";

const run = promisify(execFile);
const repository = "example-org/demo";
const operatorToken = "gho_operator";

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("a test tried to reach the network");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the scripted demo", () => {
  it("refuses dev-bot until both lanes have accepted the current head", async () => {
    const dev = identity(501, 601, "dev-bot");
    const review = identity(502, 602, "review-bot");
    const qa = identity(503, 603, "qa-bot");
    expect(new Set([dev.app.id, review.app.id, qa.app.id]).size).toBe(3);

    const simulator = new GitHubSimulator({
      app: dev.app,
      apps: [review.app, qa.app],
      operatorTokens: [operatorToken],
    });
    simulator.commitOn(repository, {
      branch: "main",
      message: "Import the buggy demo program.\n",
      files: await projectFiles(),
    });
    simulator.ruleset(
      repository,
      demoRuleset({
        branch: "main",
        reviewAppId: review.app.id,
        qaAppId: qa.app.id,
      }),
    );

    const lines: string[] = [];
    const result = await runScenario(
      {
        dev: forge(dev, simulator),
        review: forge(review, simulator),
        qa: forge(qa, simulator),
      },
      githubDemoSide({
        repository,
        operatorToken,
        dev: credentials(dev),
        qa: credentials(qa),
        fetch: simulator.fetch,
        apiUrl: GitHubSimulator.apiUrl,
      }),
      (line) => {
        lines.push(line);
      },
    );

    expect(result.outcomes).toEqual([
      "blocked",
      "blocked",
      "blocked",
      "merged",
    ]);
    const merges = simulator.requests.filter(
      (request) => request.method === "PUT" && request.path.endsWith("/merge"),
    );
    expect(merges).toHaveLength(4);
    expect(merges[3]?.body).toEqual({ sha: result.heads[1] });
    expect(
      merges.map((request) => (request.body as { sha?: string }).sha),
    ).toEqual([
      result.heads[0],
      result.heads[0],
      result.heads[1],
      result.heads[1],
    ]);
    expect(simulator.issues(repository).map((issue) => issue.state)).toEqual([
      "closed",
    ]);
    expect(
      simulator
        .checkRuns(repository)
        .filter((check) => check.app?.id === dev.app.id),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "review",
          head_sha: result.heads[0],
          conclusion: "success",
        }),
        expect.objectContaining({
          name: "qa",
          head_sha: result.heads[0],
          conclusion: "success",
        }),
      ]),
    );
    expect(
      simulator
        .checkRuns(repository)
        .some((check) => check.output?.summary?.includes("Scripted verdict")),
    ).toBe(true);
    expect(lines.join("\n")).toMatch(
      /dev-bot\s+merge @.{7}\s+-> BLOCKED \(required checks missing\)/,
    );
    expect(lines.join("\n")).toMatch(
      /dev-bot\s+merge @.{7}\s+-> BLOCKED \(forged checks do not count\)/,
    );
    expect(lines.join("\n")).toMatch(
      /dev-bot\s+merge @.{7}\s+-> BLOCKED \(new head has no lane verdicts\)/,
    );
    expect(lines.join("\n")).toMatch(/dev-bot\s+merge @.{7}\s+-> MERGED/);
  });
});

describe("the demo program", () => {
  it("fails its test until the fix patch", async () => {
    const files = await projectFiles();
    await expect(nodeTest(files)).rejects.toThrow();
    await nodeTest(await applyPatch(files, patchFile(FIX_PATCH)));
  });
});

function forge(
  { app, privateKey }: Identity,
  simulator: GitHubSimulator,
): GitHubForge {
  return new GitHubForge({
    appId: app.id,
    privateKey,
    lanes: ["review", "qa"],
    fetch: simulator.fetch,
  });
}

interface Identity {
  readonly app: SimulatedApp;
  readonly privateKey: string;
}

function credentials(identity: Identity): AppCredentials {
  return { appId: identity.app.id, privateKey: identity.privateKey };
}

function identity(id: number, installationId: number, slug: string): Identity {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    app: { id, slug, installationId, publicKey: keys.publicKey },
    privateKey: keys.privateKey,
  };
}

async function nodeTest(files: readonly ProjectFile[]): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "forgecrew-template-"));
  try {
    for (const file of files) {
      const target = join(directory, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    await run(process.execPath, ["--test"], { cwd: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
