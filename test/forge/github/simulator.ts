import { execFileSync } from "node:child_process";
import { createVerify, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import type { RestEndpointMethodTypes } from "@octokit/rest";

/**
 * GitHub's REST API, in memory, for the routes the GitHub adapter calls. It
 * answers through `fetch`, which the adapter hands to Octokit, and refuses
 * any other host, so a test never reaches GitHub.
 *
 * Request and response shapes follow GitHub's REST documentation: stored
 * objects are typed as partial versions of the response types Octokit
 * generates from GitHub's OpenAPI description, so every field a test sets has
 * GitHub's name and type. Authentication follows a GitHub App's: an App JWT
 * for the installation lookup and token, the installation token for the rest.
 */
export class GitHubSimulator {
  static readonly apiUrl = "https://api.github.com";

  /** Every request the adapter made, in order. */
  readonly requests: Recorded[] = [];

  readonly #app: SimulatedApp;
  readonly #gitRoot: string | undefined;
  readonly #maxPerPage: number;
  readonly #repositories = new Map<string, Repository>();
  readonly #tokens = new Set<string>();
  #lastId = 100_000;

  constructor({ app, gitRoot, maxPerPage = 100 }: SimulatorOptions) {
    this.#app = app;
    this.#gitRoot = gitRoot;
    this.#maxPerPage = maxPerPage;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const response = await this.#respond(request);
    // A real fetch reports the URL it fetched, and Octokit reads it.
    Object.defineProperty(response, "url", { value: request.url });
    return response;
  };

  async #respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== GitHubSimulator.apiUrl) {
      throw new Error(`the GitHub simulator refuses a request to ${url}`);
    }
    const body: unknown =
      request.body === null ? undefined : await request.json();
    this.requests.push({ method: request.method, path: url.pathname, body });

    for (const route of routes) {
      const match = route.pattern.exec({ pathname: url.pathname });
      if (request.method !== route.method || match === null) continue;
      const refused = this.#authenticate(route.auth, request.headers);
      if (refused !== undefined) return refused;
      const params = Object.fromEntries(
        Object.entries(match.pathname.groups).map(([name, value]) => [
          name,
          decodeURIComponent(value ?? ""),
        ]),
      );
      return route.handle(this, { url, params, body: asObject(body) });
    }
    throw new Error(
      `the GitHub simulator has no route for ${request.method} ${url.pathname}`,
    );
  }

  // Seeding, in GitHub's own terms.

  pullRequest(repository: string, pull: Fixture<PullRequest>): void {
    this.#repository(repository).pulls.set(pull.number ?? 0, pull);
  }

  pullFiles(
    repository: string,
    number: number,
    files: Fixture<DiffEntry>[],
  ): void {
    this.#repository(repository).files.set(number, files);
  }

  /** A plain issue, which GitHub's issues list returns beside pull requests. */
  issue(repository: string, issue: Fixture<Issue>): void {
    this.#repository(repository).issues.push(issue);
  }

  checkRun(repository: string, run: Fixture<CheckRun>): void {
    this.#repository(repository).checkRuns.push(run);
  }

  commitStatus(
    repository: string,
    sha: string,
    status: Fixture<CommitStatus>,
  ): void {
    const { statuses } = this.#repository(repository);
    statuses.set(sha, [...(statuses.get(sha) ?? []), status]);
  }

  issueComment(
    repository: string,
    number: number,
    issueComment: Fixture<IssueComment>,
  ): void {
    listIn(this.#repository(repository).issueComments, number).push(
      issueComment,
    );
  }

  reviewComment(
    repository: string,
    number: number,
    reviewComment: Fixture<ReviewComment>,
  ): void {
    listIn(this.#repository(repository).reviewComments, number).push(
      reviewComment,
    );
  }

  /** Seeds a branch as already deleted. */
  branchDeleted(repository: string, branch: string): void {
    this.#repository(repository).deletedRefs.push(`heads/${branch}`);
  }

  /** The refs deleted, through the API or as seeded. */
  deletedRefs(repository: string): readonly string[] {
    return this.#repository(repository).deletedRefs;
  }

  /** The installation tokens issued so far. */
  get tokens(): readonly string[] {
    return [...this.#tokens];
  }

  // Route handlers.

  getRepoInstallation({ params }: Call): Response {
    return json(200, {
      id: this.#app.installationId,
      app_id: this.#app.id,
      account: { login: params.owner },
    } satisfies Fixture<Installation>);
  }

  createInstallationToken({ params }: Call): Response {
    if (Number(params.id) !== this.#app.installationId) return notFound();
    const token = `ghs_${randomBytes(18).toString("hex")}`;
    this.#tokens.add(token);
    return json(201, {
      token,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: {
        checks: "write",
        contents: "write",
        pull_requests: "write",
      },
      repository_selection: "all",
    } satisfies Fixture<InstallationToken>);
  }

  listIssues({ url, params }: Call): Response {
    const since = url.searchParams.get("since");
    const state = url.searchParams.get("state") ?? "open";
    const repository = this.#repository(repoOf(params));
    const pulls = [...repository.pulls.keys()].map((number) =>
      this.#pull({ ...params, number: String(number) }),
    );
    const issues = [
      ...repository.issues,
      ...pulls.map(
        (pull): Fixture<Issue> => ({
          number: pull?.number,
          state: pull?.state,
          user: pull?.user,
          updated_at: pull?.updated_at,
          pull_request: { merged_at: pull?.merged_at, url: pull?.url },
        }),
      ),
    ]
      .filter(
        (issue) =>
          (state === "all" || issue.state === state) &&
          (since === null ||
            Date.parse(issue.updated_at ?? "") >= Date.parse(since)),
      )
      .toSorted(
        (a, b) =>
          Date.parse(a.updated_at ?? "") - Date.parse(b.updated_at ?? ""),
      );
    return this.#page(url, issues);
  }

  getPull({ params }: Call): Response {
    const pull = this.#pull(params);
    return pull === undefined ? notFound() : json(200, pull);
  }

  listCheckRuns({ url, params }: Call): Response {
    const runs = this.#repository(repoOf(params)).checkRuns.filter(
      (run) => run.head_sha === params.ref,
    );
    // GitHub's default, `latest`, lists only the newest run of each check.
    if (url.searchParams.get("filter") === "all") {
      return this.#page(url, runs, "check_runs");
    }
    const latest = new Map<string, Fixture<CheckRun>>();
    for (const run of runs) {
      const key = `${run.app?.id}/${run.name}`;
      const seen = latest.get(key);
      if (seen === undefined || (run.id ?? 0) > (seen.id ?? 0)) {
        latest.set(key, run);
      }
    }
    return this.#page(url, [...latest.values()], "check_runs");
  }

  listFiles({ url, params }: Call): Response {
    if (this.#pull(params) === undefined) return notFound();
    return this.#page(
      url,
      this.#repository(repoOf(params)).files.get(Number(params.number)) ?? [],
    );
  }

  getCombinedStatus({ url, params }: Call): Response {
    const all = this.#repository(repoOf(params)).statuses.get(params.ref ?? "");
    // The latest status per context. With none, GitHub reports `pending`.
    const latest = [
      ...new Map(
        (all ?? []).map((status) => [status.context, status]),
      ).values(),
    ];
    const state = latest.some(({ state }) => state !== "success")
      ? latest.some(({ state }) => state === "failure" || state === "error")
        ? "failure"
        : "pending"
      : latest.length === 0
        ? "pending"
        : "success";
    const perPage = this.#perPage(url);
    const page = Number(url.searchParams.get("page") ?? 1);
    return json(200, {
      state,
      sha: params.ref,
      statuses: latest.slice((page - 1) * perPage, page * perPage),
      total_count: latest.length,
    } satisfies Fixture<CombinedStatus>);
  }

  listIssueComments({ url, params }: Call): Response {
    return this.#page(
      url,
      this.#repository(repoOf(params)).issueComments.get(
        Number(params.number),
      ) ?? [],
    );
  }

  listReviewComments({ url, params }: Call): Response {
    return this.#page(
      url,
      this.#repository(repoOf(params)).reviewComments.get(
        Number(params.number),
      ) ?? [],
    );
  }

  createCheckRun({ params, body }: Call): Response {
    if (typeof body.name !== "string" || typeof body.head_sha !== "string") {
      return invalid("name and head_sha are required");
    }
    const conclusion = optional(body.conclusion);
    const run: Fixture<CheckRun> = {
      id: this.#nextId(),
      name: body.name,
      head_sha: body.head_sha,
      status: conclusion === undefined ? statusOf(body.status) : "completed",
      conclusion: (conclusion ?? null) as CheckRun["conclusion"],
      started_at: optional(body.started_at) ?? timestamp(),
      completed_at:
        conclusion === undefined
          ? null
          : (optional(body.completed_at) ?? timestamp()),
      output: outputOf(body.output, { title: null, summary: null }),
      app: { id: this.#app.id, slug: this.#app.slug },
    };
    this.#repository(repoOf(params)).checkRuns.push(run);
    return json(201, run);
  }

  getCheckRun({ params }: Call): Response {
    const run = this.#checkRun(params);
    return run === undefined ? notFound() : json(200, run);
  }

  updateCheckRun({ params, body }: Call): Response {
    const run = this.#checkRun(params);
    if (run === undefined) return notFound();
    if (run.app?.id !== this.#app.id) {
      return json(403, { message: `Invalid app_id \`${this.#app.id}\`` });
    }
    const conclusion = optional(body.conclusion);
    if (conclusion !== undefined) {
      run.status = "completed";
      run.conclusion = conclusion as CheckRun["conclusion"];
      run.completed_at = optional(body.completed_at) ?? timestamp();
    } else if (body.status !== undefined) {
      run.status = statusOf(body.status);
    }
    run.output = outputOf(body.output, run.output ?? {});
    return json(200, run);
  }

  // GitHub accepts a review comment only on a file in the diff, and on a line
  // only where the diff shows it.
  createReviewComment({ params, body }: Call): Response {
    const pull = this.#pull(params);
    if (pull === undefined) return notFound();
    const { commit_id, path, line, side, subject_type } = body;
    if (
      typeof body.body !== "string" ||
      typeof commit_id !== "string" ||
      typeof path !== "string"
    ) {
      return invalid("body, commit_id and path are required");
    }
    const file = this.#repository(repoOf(params))
      .files.get(Number(params.number))
      ?.find((candidate) => candidate.filename === path);
    if (file === undefined) {
      return invalid("pull_request_review_thread.path is not part of the diff");
    }
    const onFile = subject_type === "file";
    if (!onFile && typeof line !== "number") {
      return invalid("line is required unless subject_type is file");
    }
    if (typeof line === "number" && !headLinesIn(file.patch).has(line)) {
      return invalid(
        "pull_request_review_thread.line must be part of the diff",
      );
    }
    const reviewComment: Fixture<ReviewComment> = {
      id: this.#nextId(),
      body: body.body,
      commit_id,
      original_commit_id: commit_id,
      path,
      subject_type: onFile ? "file" : "line",
      ...(typeof line === "number"
        ? {
            line,
            original_line: line,
            side: side === "LEFT" ? "LEFT" : "RIGHT",
          }
        : {}),
      user: this.#botUser(),
      created_at: timestamp(),
    };
    this.reviewComment(repoOf(params), Number(params.number), reviewComment);
    pull.updated_at = timestamp();
    return json(201, reviewComment);
  }

  requestReviewers({ params, body }: Call): Response {
    const pull = this.#pull(params);
    if (pull === undefined) return notFound();
    const requested = pull.requested_reviewers ?? [];
    for (const login of Array.isArray(body.reviewers) ? body.reviewers : []) {
      if (!requested.some((user) => user?.login === login)) {
        requested.push({ login: String(login), type: "User" });
      }
    }
    pull.requested_reviewers = requested;
    pull.updated_at = timestamp();
    return json(201, pull);
  }

  createIssueComment({ params, body }: Call): Response {
    const pull = this.#pull(params);
    if (pull === undefined) return notFound();
    if (typeof body.body !== "string") return invalid("body is required");
    const issueComment: Fixture<IssueComment> = {
      id: this.#nextId(),
      body: body.body,
      user: this.#botUser(),
      created_at: timestamp(),
    };
    this.issueComment(repoOf(params), Number(params.number), issueComment);
    pull.updated_at = timestamp();
    return json(201, issueComment);
  }

  mergePull({ params, body }: Call): Response {
    const pull = this.#pull(params);
    if (pull === undefined) return notFound();
    if (pull.state !== "open" || pull.draft) {
      return json(405, { message: "Pull Request is not mergeable" });
    }
    if (body.sha !== undefined && body.sha !== this.#headOf(params, pull)) {
      return json(409, {
        message: "Head branch was modified. Review and try the merge again.",
      });
    }
    pull.state = "closed";
    pull.merged = true;
    pull.merged_at = timestamp();
    pull.updated_at = pull.merged_at;
    return json(200, {
      sha: randomBytes(20).toString("hex"),
      merged: true,
      message: "Pull Request successfully merged",
    } satisfies Fixture<MergeResult>);
  }

  deleteRef({ params }: Call): Response {
    const repository = this.#repository(repoOf(params));
    const ref = params.ref ?? "";
    const branches = [...repository.pulls.values()].map(
      (pull) => `heads/${pull.head?.ref}`,
    );
    if (!branches.includes(ref) || repository.deletedRefs.includes(ref)) {
      return invalid("Reference does not exist");
    }
    repository.deletedRefs.push(ref);
    return new Response(null, { status: 204 });
  }

  graphql({ body }: Call): Response {
    const { query, variables } = body;
    if (
      typeof query !== "string" ||
      !query.includes("markPullRequestReadyForReview")
    ) {
      return json(200, { errors: [{ message: "unsupported query" }] });
    }
    const id = asObject(variables).id;
    const pull = [...this.#repositories.values()]
      .flatMap((repository) => [...repository.pulls.values()])
      .find((candidate) => candidate.node_id === id);
    if (pull === undefined) {
      return json(200, { errors: [{ message: `no pull request ${id}` }] });
    }
    pull.draft = false;
    pull.updated_at = timestamp();
    return json(200, {
      data: { markPullRequestReadyForReview: { clientMutationId: null } },
    });
  }

  // Helpers.

  #authenticate(auth: Auth, headers: Headers): Response | undefined {
    const [scheme, credential] = (headers.get("authorization") ?? "").split(
      " ",
    );
    const valid =
      auth === "app"
        ? scheme?.toLowerCase() === "bearer" && this.#isAppJwt(credential ?? "")
        : scheme?.toLowerCase() === "token" &&
          this.#tokens.has(credential ?? "");
    return valid
      ? undefined
      : json(401, { message: "Bad credentials", status: "401" });
  }

  // An App authenticates with a JWT it signs with its private key, issued by
  // its App ID and valid for at most ten minutes.
  #isAppJwt(jwt: string): boolean {
    const [header, payload, signature] = jwt.split(".");
    if (header === undefined || payload === undefined || !signature) {
      return false;
    }
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    if (!verifier.verify(this.#app.publicKey, signature, "base64url")) {
      return false;
    }
    const claims = asObject(
      JSON.parse(Buffer.from(payload, "base64url").toString()),
    );
    const now = Date.now() / 1000;
    return (
      String(claims.iss) === String(this.#app.id) &&
      typeof claims.exp === "number" &&
      claims.exp > now &&
      claims.exp - now <= 600
    );
  }

  #perPage(url: URL): number {
    return Math.min(
      Number(url.searchParams.get("per_page") ?? 30),
      this.#maxPerPage,
    );
  }

  #page<T>(url: URL, items: T[], key?: string): Response {
    const perPage = this.#perPage(url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next}>; rel="next"`;
    }
    const body =
      key === undefined ? slice : { total_count: items.length, [key]: slice };
    return json(200, body, headers);
  }

  // A pull request's head follows its branch in the stand-in Git repository,
  // once the test has one, so a push moves it as it would on GitHub.
  #pull(params: Params): Fixture<PullRequest> | undefined {
    const pull = this.#repository(repoOf(params)).pulls.get(
      Number(params.number),
    );
    if (pull?.head === undefined) return pull;
    const head = this.#headOf(params, pull);
    if (head !== pull.head.sha) {
      pull.head.sha = head;
      pull.updated_at = timestamp();
    }
    return pull;
  }

  #headOf(params: Params, pull: Fixture<PullRequest>): string | undefined {
    const bare = this.#gitRoot && join(this.#gitRoot, `${repoOf(params)}.git`);
    if (!bare || !existsSync(bare)) return pull.head?.sha;
    return execFileSync(
      "git",
      ["rev-parse", "--verify", `refs/heads/${pull.head?.ref}`],
      {
        cwd: bare,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: devNull,
        },
      },
    ).trim();
  }

  #checkRun(params: Params): Fixture<CheckRun> | undefined {
    return this.#repository(repoOf(params)).checkRuns.find(
      (run) => run.id === Number(params.id),
    );
  }

  #repository(path: string): Repository {
    let repository = this.#repositories.get(path);
    if (repository === undefined) {
      repository = {
        pulls: new Map(),
        files: new Map(),
        issues: [],
        checkRuns: [],
        statuses: new Map(),
        issueComments: new Map(),
        reviewComments: new Map(),
        deletedRefs: [],
      };
      this.#repositories.set(path, repository);
    }
    return repository;
  }

  #botUser(): Fixture<PullRequest["user"]> {
    return { login: `${this.#app.slug}[bot]`, type: "Bot" };
  }

  #nextId(): number {
    return ++this.#lastId;
  }
}

export interface SimulatedApp {
  readonly id: number;
  readonly slug: string;
  readonly installationId: number;
  /** The public half of the key the App signs its JWTs with, PEM-encoded. */
  readonly publicKey: string;
}

export interface SimulatorOptions {
  readonly app: SimulatedApp;
  /**
   * The directory of bare repositories that stand in for GitHub's Git
   * hosting, one at `<owner>/<name>.git` per repository.
   */
  readonly gitRoot?: string;
  /** The most items a page holds; GitHub's own maximum is 100. */
  readonly maxPerPage?: number;
}

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A partial version of a GitHub response type, at every depth. */
export type Fixture<T> = T extends readonly (infer Item)[]
  ? Fixture<Item>[]
  : T extends object
    ? { -readonly [K in keyof T]?: Fixture<T[K]> }
    : T;

type Data<
  Scope extends keyof RestEndpointMethodTypes,
  Method extends keyof RestEndpointMethodTypes[Scope],
> = RestEndpointMethodTypes[Scope][Method] extends {
  response: { data: infer Body };
}
  ? Body
  : never;

export type PullRequest = Data<"pulls", "get">;
export type CheckRun = Data<"checks", "get">;
export type CombinedStatus = Data<"repos", "getCombinedStatusForRef">;
export type CommitStatus = CombinedStatus["statuses"][number];
export type IssueComment = Data<"issues", "getComment">;
export type ReviewComment = Data<"pulls", "getReviewComment">;
export type Issue = Data<"issues", "get">;
export type DiffEntry = Data<"pulls", "listFiles">[number];
type Installation = Data<"apps", "getRepoInstallation">;
type InstallationToken = Data<"apps", "createInstallationAccessToken">;
type MergeResult = Data<"pulls", "merge">;

interface Repository {
  readonly pulls: Map<number, Fixture<PullRequest>>;
  readonly files: Map<number, Fixture<DiffEntry>[]>;
  readonly issues: Fixture<Issue>[];
  readonly checkRuns: Fixture<CheckRun>[];
  readonly statuses: Map<string, Fixture<CommitStatus>[]>;
  readonly issueComments: Map<number, Fixture<IssueComment>[]>;
  readonly reviewComments: Map<number, Fixture<ReviewComment>[]>;
  readonly deletedRefs: string[];
}

type Auth = "app" | "installation";
type Params = Record<string, string | undefined>;

interface Call {
  readonly url: URL;
  readonly params: Params;
  readonly body: Record<string, unknown>;
}

interface Route {
  readonly method: string;
  readonly pattern: URLPattern;
  readonly auth: Auth;
  readonly handle: (simulator: GitHubSimulator, call: Call) => Response;
}

const routes: Route[] = [
  route("GET", "/repos/:owner/:repo/installation", "app", (s, c) =>
    s.getRepoInstallation(c),
  ),
  route("POST", "/app/installations/:id/access_tokens", "app", (s, c) =>
    s.createInstallationToken(c),
  ),
  route("GET", "/repos/:owner/:repo/issues", "installation", (s, c) =>
    s.listIssues(c),
  ),
  route("GET", "/repos/:owner/:repo/pulls/:number", "installation", (s, c) =>
    s.getPull(c),
  ),
  route(
    "GET",
    "/repos/:owner/:repo/pulls/:number/files",
    "installation",
    (s, c) => s.listFiles(c),
  ),
  route(
    "GET",
    "/repos/:owner/:repo/commits/:ref/check-runs",
    "installation",
    (s, c) => s.listCheckRuns(c),
  ),
  route(
    "GET",
    "/repos/:owner/:repo/commits/:ref/status",
    "installation",
    (s, c) => s.getCombinedStatus(c),
  ),
  route(
    "GET",
    "/repos/:owner/:repo/issues/:number/comments",
    "installation",
    (s, c) => s.listIssueComments(c),
  ),
  route(
    "GET",
    "/repos/:owner/:repo/pulls/:number/comments",
    "installation",
    (s, c) => s.listReviewComments(c),
  ),
  route("POST", "/repos/:owner/:repo/check-runs", "installation", (s, c) =>
    s.createCheckRun(c),
  ),
  route("GET", "/repos/:owner/:repo/check-runs/:id", "installation", (s, c) =>
    s.getCheckRun(c),
  ),
  route("PATCH", "/repos/:owner/:repo/check-runs/:id", "installation", (s, c) =>
    s.updateCheckRun(c),
  ),
  route(
    "POST",
    "/repos/:owner/:repo/pulls/:number/comments",
    "installation",
    (s, c) => s.createReviewComment(c),
  ),
  route(
    "POST",
    "/repos/:owner/:repo/pulls/:number/requested_reviewers",
    "installation",
    (s, c) => s.requestReviewers(c),
  ),
  route(
    "POST",
    "/repos/:owner/:repo/issues/:number/comments",
    "installation",
    (s, c) => s.createIssueComment(c),
  ),
  route(
    "PUT",
    "/repos/:owner/:repo/pulls/:number/merge",
    "installation",
    (s, c) => s.mergePull(c),
  ),
  route(
    "DELETE",
    "/repos/:owner/:repo/git/refs/:ref+",
    "installation",
    (s, c) => s.deleteRef(c),
  ),
  route("POST", "/graphql", "installation", (s, c) => s.graphql(c)),
];

function route(
  method: string,
  pathname: string,
  auth: Auth,
  handle: Route["handle"],
): Route {
  return { method, pattern: new URLPattern({ pathname }), auth, handle };
}

// The head's lines a patch shows: its context and added lines, counted from
// each hunk's `+start`.
function headLinesIn(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  let next = 0;
  for (const text of (patch ?? "").split("\n")) {
    const hunk = /^@@ -\S+ \+(\d+)/.exec(text);
    if (hunk !== null) next = Number(hunk[1]);
    else if (text.startsWith(" ") || text.startsWith("+")) lines.add(next++);
  }
  return lines;
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function notFound(): Response {
  return json(404, { message: "Not Found" });
}

function invalid(message: string): Response {
  return json(422, { message: "Validation Failed", errors: [{ message }] });
}

function repoOf({ owner, repo }: Params): string {
  return `${owner}/${repo}`;
}

function listIn<T>(lists: Map<number, T[]>, number: number): T[] {
  let list = lists.get(number);
  if (list === undefined) {
    list = [];
    lists.set(number, list);
  }
  return list;
}

function statusOf(status: unknown): CheckRun["status"] {
  return status === "in_progress" || status === "completed" ? status : "queued";
}

function outputOf(
  output: unknown,
  current: Fixture<CheckRun["output"]>,
): Fixture<CheckRun["output"]> {
  const { title, summary } = asObject(output);
  return {
    ...current,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof summary === "string" ? { summary } : {}),
  };
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

// GitHub's timestamps carry no fractions of a second.
function timestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
