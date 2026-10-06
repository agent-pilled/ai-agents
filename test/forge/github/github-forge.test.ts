import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { GitHubForge } from "../../../src/adapters/forge/index.ts";
import type { CiState, PassResult } from "../../../src/core/domain/index.ts";
import { localRepository, temporaryDirectory } from "../git.ts";
import { aChange, head, identity, ref, repository, world } from "../world.ts";
import { app, gitHubForge, slugOf } from "./harness.ts";
import type { CheckRun, CommitStatus, Fixture } from "./simulator.ts";

// GitHub mapping details the contract suite cannot see. The suite already
// runs every port operation against the simulated GitHub.

describe("the GitHub forge", () => {
  it("authenticates as the App, then as its installation on the repository", async () => {
    const { forge, simulator } = await gitHubForge(
      world({ changes: [aChange()] }),
    );

    await forge.readChange(ref());

    expect(simulator.requests.slice(0, 3)).toEqual([
      {
        method: "GET",
        path: `/repos/${repository}/installation`,
        body: undefined,
      },
      {
        method: "POST",
        path: `/app/installations/${app.installationId}/access_tokens`,
        body: undefined,
      },
      { method: "GET", path: `/repos/${repository}/pulls/7`, body: undefined },
    ]);
  });

  it("is refused with a key that is not the App's", async () => {
    const { simulator } = await gitHubForge(world({ changes: [aChange()] }));
    const stranger = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const forge = new GitHubForge({
      appId: app.id,
      privateKey: stranger.privateKey,
      lanes: ["review"],
      fetch: simulator.fetch,
    });

    await expect(forge.readChange(ref())).rejects.toMatchObject({
      status: 401,
    });
  });

  it.each<[PassResult, string]>([
    ["accepted", "success"],
    ["issues", "failure"],
    ["cancelled", "cancelled"],
    ["timed_out", "timed_out"],
    ["action_required", "action_required"],
  ])(
    "records a claim closed as %s as a check run concluded as %s",
    async (result, conclusion) => {
      const { forge, simulator } = await gitHubForge(
        world({ changes: [aChange()] }),
      );

      const claim = await forge.claim(
        { change: ref(), lane: "review", head },
        "Reviewing.",
      );
      await forge.closeClaim(claim, result, "Done.");

      const writes = simulator.requests.filter(({ method }) =>
        ["POST", "PATCH"].includes(method),
      );
      expect(writes.slice(1)).toEqual([
        {
          method: "POST",
          path: `/repos/${repository}/check-runs`,
          body: {
            name: "review",
            head_sha: head,
            status: "in_progress",
            started_at: expect.any(String),
            output: { title: "In progress", summary: "Reviewing." },
          },
        },
        {
          method: "PATCH",
          path: `/repos/${repository}/check-runs/${claim.id}`,
          body: {
            conclusion,
            completed_at: expect.any(String),
            output: { title: expect.any(String), summary: "Done." },
          },
        },
      ]);
    },
  );

  it("submits no review, so never an approval", async () => {
    const local = await localRepository(aChange().branch);
    const { forge, simulator } = await gitHubForge(
      world({
        changes: [aChange({ head: local.base })],
        remotes: { [repository]: local.path },
      }),
    );

    const claim = await forge.claim(
      { change: ref(), lane: "review", head: local.base },
      "Reviewing.",
    );
    await forge.postFindings(ref(), local.base, [
      { path: "src/a.ts", line: 3, body: "This can throw." },
    ]);
    await forge.closeClaim(claim, "accepted", "Accepted.");
    await forge.publish(ref(), {
      source: local.path,
      head: local.next,
      expectedHead: local.base,
    });
    await forge.markReady(ref(), { reviewer: "jane-doe", comment: "Ready." });
    await forge.merge(ref(), local.next);

    expect(simulator.requests.map(({ path }) => path)).not.toContainEqual(
      expect.stringMatching(/\/reviews/),
    );
  });

  it("posts each finding as a review comment on the head's side of the diff", async () => {
    const { forge, simulator } = await gitHubForge(
      world({ changes: [aChange()] }),
    );

    await forge.postFindings(ref(), head, [
      { path: "src/a.ts", line: 3, body: "This can throw." },
    ]);

    expect(simulator.requests.at(-1)).toEqual({
      method: "POST",
      path: `/repos/${repository}/pulls/7/comments`,
      body: {
        commit_id: head,
        path: "src/a.ts",
        line: 3,
        side: "RIGHT",
        body: "This can throw.",
      },
    });
  });

  it("posts a finding without a line as a comment on the file", async () => {
    const { forge, simulator } = await gitHubForge(
      world({ changes: [aChange()] }),
    );

    await forge.postFindings(ref(), head, [
      { path: "src/b.ts", body: "Split this file." },
    ]);

    expect(simulator.requests.at(-1)).toEqual({
      method: "POST",
      path: `/repos/${repository}/pulls/7/comments`,
      body: {
        commit_id: head,
        path: "src/b.ts",
        subject_type: "file",
        body: "Split this file.",
      },
    });
  });

  describe("CI", () => {
    const lane = (conclusion: CheckRun["conclusion"]): Fixture<CheckRun> => ({
      name: "review",
      status: "completed",
      conclusion,
      started_at: "2026-01-01T00:00:00Z",
      output: { summary: "" },
      app: { id: app.id, slug: slugOf(identity) },
    });
    const ci = (
      name: string,
      status: CheckRun["status"],
      conclusion: CheckRun["conclusion"] = null,
    ): Fixture<CheckRun> => ({
      name,
      status,
      conclusion,
      started_at: "2026-01-01T00:00:00Z",
      app: { id: 15368, slug: "github-actions" },
    });

    it.each<{
      name: string;
      runs?: Fixture<CheckRun>[];
      statuses?: Fixture<CommitStatus>[];
      expected: CiState;
    }>([
      { name: "nothing on the head", expected: "none" },
      {
        name: "only lane check runs",
        runs: [lane("failure")],
        expected: "none",
      },
      {
        name: "a lane's failure beside CI's success",
        runs: [lane("failure"), ci("Check", "completed", "success")],
        expected: "success",
      },
      {
        name: "a failed run superseded by a successful rerun",
        runs: [
          ci("Check", "completed", "failure"),
          ci("Check", "completed", "success"),
        ],
        expected: "success",
      },
      {
        name: "neutral and skipped runs",
        runs: [
          ci("Docs", "completed", "neutral"),
          ci("Deploy", "completed", "skipped"),
        ],
        expected: "success",
      },
      {
        name: "a queued run beside a successful one",
        runs: [ci("Check", "completed", "success"), ci("E2E", "queued")],
        expected: "pending",
      },
      {
        name: "a failure beside a queued run",
        runs: [ci("Check", "completed", "failure"), ci("E2E", "queued")],
        expected: "failure",
      },
      {
        name: "a pending commit status",
        statuses: [{ context: "ci/legacy", state: "pending" }],
        expected: "pending",
      },
      {
        name: "a commit status in error",
        runs: [ci("Check", "completed", "success")],
        statuses: [{ context: "ci/legacy", state: "error" }],
        expected: "failure",
      },
    ])(
      "reads $name as $expected",
      async ({ runs = [], statuses = [], expected }) => {
        const { forge, simulator } = await gitHubForge(
          world({ changes: [aChange({ ci: "none" })] }),
        );
        for (const [index, run] of runs.entries()) {
          simulator.checkRun(repository, {
            id: index + 1,
            head_sha: head,
            ...run,
          });
        }
        for (const status of statuses) {
          simulator.commitStatus(repository, head, status);
        }

        expect((await forge.readChange(ref())).ci).toBe(expected);
      },
    );
  });

  it.each(["neutral", "skipped", "stale"])(
    "reads a lane check run concluded as %s as cancelled, never a verdict",
    async (conclusion) => {
      const { forge, simulator } = await gitHubForge(
        world({ changes: [aChange()] }),
      );
      simulator.checkRun(repository, {
        id: 9,
        name: "review",
        head_sha: head,
        status: "completed",
        // `stale` is GitHub's own; Octokit's response type leaves it out.
        conclusion: conclusion as CheckRun["conclusion"],
        started_at: "2026-01-01T00:00:00Z",
        completed_at: "2026-01-15T00:00:00Z",
        output: { summary: "" },
        app: { id: app.id, slug: slugOf(identity) },
      });

      const [record] = (await forge.readChange(ref())).verdicts;

      expect(record?.result).toBe("cancelled");
    },
  );

  it("keeps a person and an App that share a name apart", async () => {
    const { forge, simulator } = await gitHubForge(
      world({ changes: [aChange()] }),
    );
    simulator.issueComment(repository, 7, {
      id: 1,
      user: { login: "jane-doe", type: "User" },
      body: "From the person.",
      created_at: "2026-01-01T00:00:00Z",
    });
    simulator.issueComment(repository, 7, {
      id: 2,
      user: { login: "jane-doe[bot]", type: "Bot" },
      body: "From the App.",
      created_at: "2026-01-01T00:00:01Z",
    });
    simulator.checkRun(repository, {
      id: 3,
      name: "review",
      head_sha: head,
      status: "in_progress",
      started_at: "2026-01-01T00:00:02Z",
      output: { summary: "" },
      app: { id: 4004, slug: "jane-doe" },
    });

    const { comments, verdicts } = await forge.readChange(ref());

    expect(comments.map(({ author }) => author)).toEqual([
      "jane-doe",
      "jane-doe[bot]",
    ]);
    expect(verdicts[0]?.author).toBe("jane-doe[bot]");
  });

  it("reads a thread's line only from the head's side of the diff, and a range as its last line", async () => {
    const { forge, simulator } = await gitHubForge(
      world({ changes: [aChange()] }),
    );
    const author = { login: "jane-doe", type: "User" };
    simulator.reviewComment(repository, 7, {
      id: 1,
      path: "src/a.ts",
      subject_type: "line",
      side: "LEFT",
      line: 40,
      commit_id: head,
      user: author,
      body: "Why remove this?",
      created_at: "2026-01-01T00:00:00Z",
    });
    simulator.reviewComment(repository, 7, {
      id: 2,
      path: "src/a.ts",
      subject_type: "line",
      side: "RIGHT",
      start_line: 3,
      line: 5,
      commit_id: head,
      user: author,
      body: "These three lines.",
      created_at: "2026-01-01T00:00:01Z",
    });

    const { threads } = await forge.readChange(ref());

    expect(threads).toEqual([
      {
        id: "1",
        path: "src/a.ts",
        anchor: "line",
        comments: [
          {
            id: "1",
            author: "jane-doe",
            body: "Why remove this?",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
      {
        id: "2",
        path: "src/a.ts",
        anchor: "line",
        line: 5,
        comments: [
          {
            id: "2",
            author: "jane-doe",
            body: "These three lines.",
            createdAt: "2026-01-01T00:00:01Z",
          },
        ],
      },
    ]);
  });

  it("lists pull requests only, not plain issues", async () => {
    const { forge, simulator } = await gitHubForge(
      world({ changes: [aChange()] }),
    );
    simulator.issue(repository, {
      number: 8,
      state: "open",
      updated_at: "2026-01-03T00:00:00Z",
    });

    expect(await forge.discover(repository)).toEqual([
      { ref: ref(), updatedAt: aChange().updatedAt },
    ]);
  });

  it("reads the commit statuses' combined state, beyond the first page", async () => {
    const { forge, simulator } = await gitHubForge(
      world({ changes: [aChange({ ci: "none" })] }),
      { maxPerPage: 1 },
    );
    simulator.commitStatus(repository, head, {
      context: "ci/first",
      state: "success",
    });
    simulator.commitStatus(repository, head, {
      context: "ci/second",
      state: "failure",
    });

    expect((await forge.readChange(ref())).ci).toBe("failure");
  });

  it("reads the lines a diff shows from each hunk of its patch", async () => {
    const { forge, simulator } = await gitHubForge(
      world({ changes: [aChange()] }),
    );
    simulator.pullFiles(repository, 7, [
      {
        filename: "src/a.ts",
        status: "modified",
        patch: [
          "@@ -1,3 +1,4 @@",
          " one",
          "-two",
          "+2",
          "+two and a half",
          " three",
          "@@ -40 +41 @@",
          "-forty",
          "+forty-one",
          "@@ -60,2 +60,0 @@",
          "-sixty",
          "-sixty-one",
        ].join("\n"),
      },
      { filename: "logo.png", status: "added" },
      {
        filename: "src/gone.ts",
        status: "removed",
        patch: "@@ -1,2 +0,0 @@\n-one\n-two",
      },
    ]);

    expect((await forge.readChange(ref())).files).toEqual([
      {
        path: "src/a.ts",
        lines: [
          { start: 1, end: 4 },
          { start: 41, end: 41 },
        ],
      },
      { path: "logo.png", lines: [] },
      { path: "src/gone.ts", lines: [] },
    ]);
  });

  it("reads every page of a long list", async () => {
    const comments = ["101", "102", "103"].map((id) => ({
      id,
      author: "jane-doe",
      body: `Comment ${id}.`,
      createdAt: "2026-01-01T00:00:00Z",
    }));
    const changes = [1, 2, 3].map((number) =>
      aChange({ ref: ref(number), comments: number === 1 ? comments : [] }),
    );
    const { forge } = await gitHubForge(world({ changes }), { maxPerPage: 1 });

    expect((await forge.readChange(ref(1))).comments).toEqual(comments);
    expect(await forge.discover(repository)).toHaveLength(3);
  });

  it("deletes the branch after merging, and accepts a branch already deleted", async () => {
    const { forge, simulator } = await gitHubForge(
      world({
        changes: [
          aChange({ ref: ref(1), draft: false, branch: "feature/one" }),
          aChange({ ref: ref(2), draft: false, branch: "feature/two" }),
        ],
      }),
    );
    simulator.branchDeleted(repository, "feature/two");

    expect(await forge.merge(ref(1), head)).toBe("merged");
    expect(await forge.merge(ref(2), head)).toBe("merged");
    expect(simulator.deletedRefs(repository)).toEqual([
      "heads/feature/two",
      "heads/feature/one",
    ]);
  });

  describe("publish", () => {
    it("sends the installation token in an HTTP header", async () => {
      const seen: { url?: string; authorization?: string }[] = [];
      const server = createServer((request, response) => {
        seen.push({
          url: request.url,
          authorization: request.headers.authorization,
        });
        response.writeHead(403).end();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      onTestFinished(() => {
        server.close();
      });
      const { port } = server.address() as AddressInfo;
      const local = await localRepository(aChange().branch);
      const { forge, simulator } = await gitHubForge(
        world({ changes: [aChange({ head: local.base })] }),
        { gitUrl: `http://127.0.0.1:${port}` },
      );

      await expect(
        forge.publish(ref(), {
          source: local.path,
          head: local.next,
          expectedHead: local.base,
        }),
      ).rejects.toThrow(/git push/);

      const [token] = simulator.tokens;
      expect(seen[0]).toEqual({
        url: `/${repository}.git/info/refs?service=git-receive-pack`,
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      });
    });

    it("pushes without running the source repository's hooks", async () => {
      const local = await localRepository(aChange().branch);
      const marker = join(await temporaryDirectory("forgecrew-marker-"), "ran");
      const hook = join(local.path, ".git", "hooks", "pre-push");
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(hook, 0o755);
      const { forge } = await gitHubForge(
        world({
          changes: [aChange({ head: local.base })],
          remotes: { [repository]: local.path },
        }),
      );

      const outcome = await forge.publish(ref(), {
        source: local.path,
        head: local.next,
        expectedHead: local.base,
      });

      expect(outcome).toBe("published");
      expect(existsSync(marker)).toBe(false);
    });
  });
});
