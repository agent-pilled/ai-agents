import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubForge } from "../../../src/adapters/forge/index.ts";
import { demoRuleset } from "../../../tools/demo/ruleset.ts";
import { GitHubSimulator, type SimulatedApp } from "./simulator.ts";

// The ruleset names a check and the App allowed to satisfy it. A success from
// anyone else, and a success from the right App on a commit that is no longer
// the head, both leave the merge refused.

const repository = "example-org/demo";
const current = "a".repeat(40);
const older = "b".repeat(40);

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("a test tried to reach the network");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a ruleset bound to an App", () => {
  it("ignores a successful review check from the wrong App and from an older SHA", async () => {
    const dev = identity(501, 601, "dev-bot");
    const review = identity(502, 602, "review-bot");
    const qa = identity(503, 603, "qa-bot");
    expect(new Set([dev.app.id, review.app.id, qa.app.id]).size).toBe(3);

    const simulator = new GitHubSimulator({
      app: dev.app,
      apps: [review.app, qa.app],
    });
    simulator.pullRequest(repository, {
      number: 4,
      node_id: "PR_node_4",
      state: "open",
      merged: false,
      draft: false,
      user: { login: "dev-bot[bot]", type: "Bot" },
      updated_at: "2026-01-02T03:04:05Z",
      head: {
        ref: "forgecrew-fix-add",
        sha: current,
        repo: { full_name: repository },
      },
      base: {
        ref: "main",
        sha: older,
        repo: { full_name: repository },
      },
    });
    simulator.ruleset(
      repository,
      demoRuleset({
        branch: "main",
        reviewAppId: review.app.id,
        qaAppId: qa.app.id,
      }),
    );

    const devForge = forge(dev, simulator);
    const reviewForge = forge(review, simulator);
    const qaForge = forge(qa, simulator);
    const change = { repository, number: 4 };

    const forged = await devForge.claim(
      { change, lane: "review", head: current },
      "Forged.",
    );
    await devForge.closeClaim(forged, "accepted", "Forged success.");
    const stale = await reviewForge.claim(
      { change, lane: "review", head: older },
      "On the previous head.",
    );
    await reviewForge.closeClaim(stale, "accepted", "Accepted the old head.");
    const qaClaim = await qaForge.claim(
      { change, lane: "qa", head: current },
      "QA.",
    );
    await qaForge.closeClaim(qaClaim, "accepted", "QA accepted.");

    expect(simulator.checkRuns(repository)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: Number(forged.id),
          name: "review",
          head_sha: current,
          conclusion: "success",
          app: expect.objectContaining({ id: dev.app.id }),
        }),
        expect.objectContaining({
          name: "review",
          head_sha: older,
          conclusion: "success",
          app: expect.objectContaining({ id: review.app.id }),
        }),
      ]),
    );
    expect(await devForge.merge(change, current)).toBe("blocked");

    const fresh = await reviewForge.claim(
      { change, lane: "review", head: current },
      "On this head.",
    );
    await reviewForge.closeClaim(fresh, "accepted", "Accepted this head.");

    expect(await devForge.merge(change, current)).toBe("merged");
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
