import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/**
 * The repository ruleset for the scripted demo. It is the body of
 * "Create a repository ruleset", with no bypass actor: deletion and
 * non-fast-forward are blocked, a pull request needs no approving review,
 * and the two lane checks are bound to the lane's App. Strict mode is off,
 * so the head need not contain the latest base.
 *
 * https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset
 */

export const DEMO_RULESET_NAME = "forgecrew-demo";

export interface DemoRulesetInput {
  /** Branch the ruleset protects, such as `main`. */
  readonly branch: string;
  /** The review-bot App's id, bound to the `review` check. */
  readonly reviewAppId: number;
  /** The qa-bot App's id, bound to the `qa` check. */
  readonly qaAppId: number;
}

export interface DemoRuleset {
  readonly name: typeof DEMO_RULESET_NAME;
  readonly target: "branch";
  readonly enforcement: "active";
  readonly bypass_actors: readonly [];
  readonly conditions: {
    readonly ref_name: {
      readonly include: readonly [string];
      readonly exclude: readonly [];
    };
  };
  readonly rules: readonly [
    { readonly type: "deletion" },
    { readonly type: "non_fast_forward" },
    {
      readonly type: "pull_request";
      readonly parameters: {
        readonly required_approving_review_count: 0;
        readonly dismiss_stale_reviews_on_push: false;
        readonly require_code_owner_review: false;
        readonly require_last_push_approval: false;
        readonly required_review_thread_resolution: false;
      };
    },
    {
      readonly type: "required_status_checks";
      readonly parameters: {
        readonly strict_required_status_checks_policy: false;
        readonly do_not_enforce_on_create: false;
        readonly required_status_checks: readonly [
          { readonly context: "review"; readonly integration_id: number },
          { readonly context: "qa"; readonly integration_id: number },
        ];
      };
    },
  ];
}

export function demoRuleset({
  branch,
  reviewAppId,
  qaAppId,
}: DemoRulesetInput): DemoRuleset {
  return {
    name: DEMO_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: [`refs/heads/${branch}`],
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
            { context: "review", integration_id: reviewAppId },
            { context: "qa", integration_id: qaAppId },
          ],
        },
      },
    ],
  };
}

export interface RulesetApplyResult {
  readonly id: number;
  readonly action: "created" | "updated";
}

export interface ApplyRulesetOptions {
  readonly repository: string;
  readonly ruleset: DemoRuleset;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Defaults to https://api.github.com. */
  readonly apiUrl?: string;
}

/**
 * Creates the ruleset, or replaces the repository ruleset of the same name.
 * The token is the operator's: the demo Apps have no administration permission.
 */
export async function applyRuleset({
  repository,
  ruleset,
  token,
  fetch: fetchImpl = globalThis.fetch,
  apiUrl = "https://api.github.com",
}: ApplyRulesetOptions): Promise<RulesetApplyResult> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "forgecrew-demo",
    "x-github-api-version": "2022-11-28",
  };
  const existing = await listRulesets(fetchImpl, apiUrl, repository, headers);
  const match = existing.find((item) => item.name === ruleset.name);
  if (match === undefined) {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/rulesets`, {
      method: "POST",
      headers,
      body: JSON.stringify(ruleset),
    });
    if (response.status !== 201) {
      throw await rulesetError("creating the ruleset", response);
    }
    return { id: rulesetId(await response.json()), action: "created" };
  }
  const response = await fetchImpl(
    `${apiUrl}/repos/${repository}/rulesets/${match.id}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(ruleset),
    },
  );
  if (!response.ok) throw await rulesetError("updating the ruleset", response);
  return { id: rulesetId(await response.json()), action: "updated" };
}

interface ListedRuleset {
  readonly id: number;
  readonly name: string;
}

async function listRulesets(
  fetchImpl: typeof globalThis.fetch,
  apiUrl: string,
  repository: string,
  headers: Readonly<Record<string, string>>,
): Promise<ListedRuleset[]> {
  const found: ListedRuleset[] = [];
  let url: string | undefined =
    `${apiUrl}/repos/${repository}/rulesets?per_page=100`;
  while (url !== undefined) {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) throw await rulesetError("listing rulesets", response);
    const page: unknown = await response.json();
    if (!Array.isArray(page)) {
      throw new Error("GitHub returned no ruleset list");
    }
    for (const item of page) {
      const record = asRecord(item);
      if (typeof record.id === "number" && typeof record.name === "string") {
        found.push({ id: record.id, name: record.name });
      }
    }
    url = nextLink(response.headers.get("link"), apiUrl);
  }
  return found;
}

function nextLink(header: string | null, apiUrl: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    const candidate = match?.[1];
    if (candidate?.startsWith(apiUrl)) return candidate;
  }
  return undefined;
}

function rulesetId(body: unknown): number {
  const id = asRecord(body).id;
  if (typeof id !== "number") {
    throw new Error("GitHub returned a ruleset without an id");
  }
  return id;
}

async function rulesetError(
  action: string,
  response: Response,
): Promise<Error> {
  const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
  return new Error(
    `GitHub answered ${response.status} while ${action}. ${detail}`,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export interface CommandIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export const USAGE = `Usage: node tools/demo/ruleset.ts --repo <owner/name> --review-app-id <id> --qa-app-id <id> [options]

Prints the repository ruleset that binds the review check to review-bot and
the qa check to qa-bot. With --apply, creates that ruleset, or updates the
existing ruleset named ${DEMO_RULESET_NAME}. Applying needs GH_TOKEN, and this
command never applies unless you pass the flag.

Required:
  --repo <owner/name>     the demo repository
  --review-app-id <id>    the review-bot App id
  --qa-app-id <id>        the qa-bot App id

Options:
  --branch <name>         branch the ruleset protects (default: main)
  --apply                 create or update the ruleset with GH_TOKEN
  --help                  show this text
`;

/** Exit 0 when the ruleset was printed or applied, 2 for a usage error, 1 otherwise. */
export async function main(
  argv: readonly string[],
  io: CommandIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let values: {
    repo?: string;
    "review-app-id"?: string;
    "qa-app-id"?: string;
    branch?: string;
    apply?: boolean;
    help?: boolean;
  };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        repo: { type: "string" },
        "review-app-id": { type: "string" },
        "qa-app-id": { type: "string" },
        branch: { type: "string" },
        apply: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    io.stderr.write(`${message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help === true) {
    io.stdout.write(USAGE);
    return 0;
  }
  try {
    const repository = parseRepository(values.repo);
    const branch = values.branch ?? "main";
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) {
      throw new UsageError(
        `--branch ${JSON.stringify(branch)} is not a branch name.`,
      );
    }
    const ruleset = demoRuleset({
      branch,
      reviewAppId: parseAppId("--review-app-id", values["review-app-id"]),
      qaAppId: parseAppId("--qa-app-id", values["qa-app-id"]),
    });
    const token = env.GH_TOKEN;
    if (values.apply === true && (token === undefined || token === "")) {
      throw new UsageError("--apply needs GH_TOKEN in the environment.");
    }
    io.stdout.write(`${JSON.stringify(ruleset, null, 2)}\n`);
    if (values.apply !== true || token === undefined || token === "") return 0;
    const result = await applyRuleset({ repository, ruleset, token });
    const verb = result.action === "created" ? "Created" : "Updated";
    io.stdout.write(
      `${verb} ruleset ${ruleset.name} (#${result.id}) on ${repository}.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : "unknown error";
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

export class UsageError extends Error {}

export function parseRepository(value: string | undefined): string {
  if (
    value === undefined ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  ) {
    throw new UsageError("--repo must be an owner/name repository path.");
  }
  return value;
}

function parseAppId(flag: string, value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    throw new UsageError(`${flag} must be a positive integer.`);
  }
  return Number(value);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
