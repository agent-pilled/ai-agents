import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { applyRuleset, demoRuleset } from "../../../tools/demo/ruleset.ts";
import { GitHubSimulator } from "../../forge/github/simulator.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("the demo ruleset", () => {
  it("binds each lane check to that lane's App and leaves nobody a bypass", () => {
    expect(
      demoRuleset({ branch: "main", reviewAppId: 11, qaAppId: 22 }),
    ).toEqual({
      name: "forgecrew-demo",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: {
        ref_name: {
          include: ["refs/heads/main"],
          exclude: [],
        },
      },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: [
              { context: "review", integration_id: 11 },
              { context: "qa", integration_id: 22 },
            ],
          },
        },
      ],
    });
  });

  it("prints that body and does not talk to GitHub", async () => {
    const { stdout } = await run(
      process.execPath,
      [
        "tools/demo/ruleset.ts",
        "--repo",
        "a/b",
        "--review-app-id",
        "1",
        "--qa-app-id",
        "2",
      ],
      { cwd: root },
    );

    expect(JSON.parse(stdout)).toEqual(
      demoRuleset({ branch: "main", reviewAppId: 1, qaAppId: 2 }),
    );
  });

  it("creates the ruleset, then updates the same one by name", async () => {
    const simulator = new GitHubSimulator({
      app: {
        id: 1,
        slug: "dev-bot",
        installationId: 2,
        publicKey: "not used",
      },
      operatorTokens: ["gho_operator"],
    });
    const ruleset = demoRuleset({
      branch: "main",
      reviewAppId: 11,
      qaAppId: 22,
    });
    const options = {
      repository: "example-org/demo",
      ruleset,
      token: "gho_operator",
      fetch: simulator.fetch,
      apiUrl: GitHubSimulator.apiUrl,
    };

    const created = await applyRuleset(options);
    const updated = await applyRuleset(options);

    expect(created.action).toBe("created");
    expect(updated).toEqual({ id: created.id, action: "updated" });
    const writes = simulator.requests.filter(({ method }) =>
      ["POST", "PUT"].includes(method),
    );
    expect(writes.map(({ method }) => method)).toEqual(["POST", "PUT"]);
    expect(writes[0]?.body).toEqual(ruleset);
    expect(writes[1]?.body).toEqual(ruleset);
  });
});
