import { execFileSync } from "node:child_process";
import { createHash, createVerify, randomBytes } from "node:crypto";
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
 * Several Apps can be installed at once. A check run records the App that
 * created it, and a ruleset can require that App on the current head.
 *
 * Route handlers are synchronous. The authenticated actor is stored for the
 * duration of the handler, which does not await.
 */
export class GitHubSimulator {
  static readonly apiUrl = "https://api.github.com";

  /** Every request the adapter made, in order. */
  readonly requests: Recorded[] = [];

  readonly #apps: readonly SimulatedApp[];
  readonly #gitRoot: string | undefined;
  readonly #maxPerPage: number;
  readonly #repositories = new Map<string, Repository>();
  readonly #tokens = new Map<string, SimulatedApp>();
  readonly #operatorTokens: ReadonlySet<string>;
  /** Set for the synchronous part of one request. Handlers must not await. */
  #actor: Actor | undefined;
  #lastId = 100_000;

  constructor({
    app,
    apps = [],
    operatorTokens = [],
    gitRoot,
    maxPerPage = 100,
  }: SimulatorOptions) {
    const ids = new Set<number>();
    const installations = new Set<number>();
    const known: SimulatedApp[] = [];
    for (const candidate of [app, ...apps]) {
      if (ids.has(candidate.id)) {
        throw new Error(`two simulated Apps share id ${candidate.id}`);
      }
      if (installations.has(candidate.installationId)) {
        throw new Error(
          `two simulated Apps share installation ${candidate.installationId}`,
        );
      }
      ids.add(candidate.id);
      installations.add(candidate.installationId);
      known.push(candidate);
    }
    this.#apps = known;
    this.#operatorTokens = new Set(operatorTokens);
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
      try {
        return route.handle(this, { url, params, body: asObject(body) });
      } finally {
        this.#actor = undefined;
      }
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
    return [...this.#tokens.keys()];
  }

  /** The plain issues on the repository, in creation order. */
  issues(repository: string): readonly Fixture<Issue>[] {
    return this.#repository(repository).issues;
  }

  /** Every check run on the repository, in creation order. */
  checkRuns(repository: string): readonly Fixture<CheckRun>[] {
    return this.#repository(repository).checkRuns;
  }

  /**
   * Stores a ruleset. `enforcement: "active"` makes merge fail with 405 until
   * each required context has a successful check run on the current head from
   * `integration_id`, when one is set.
   */
  ruleset(repository: string, body: unknown): void {
    this.#repository(repository).rulesets.push(
      storedRuleset(this.#nextId(), asObject(body)),
    );
  }

  /**
   * Adds a commit on `branch`, creating the branch when it is new, and
   * returns the commit SHA. The files overlay the parent tree.
   */
  commitOn(
    repository: string,
    spec: {
      branch: string;
      message: string;
      files: readonly { path: string; content: string }[];
    },
  ): string {
    const stored = this.#repository(repository);
    const parent = stored.refs.get(`heads/${spec.branch}`);
    const parentCommit =
      parent === undefined ? undefined : stored.commits.get(parent);
    const tree = this.#writeTree(
      stored,
      parentCommit?.tree,
      spec.files.map((file) => ({ path: file.path, content: file.content })),
    );
    const sha = this.#writeCommit(
      stored,
      tree,
      parent === undefined ? [] : [parent],
      spec.message,
    );
    stored.refs.set(`heads/${spec.branch}`, sha);
    return sha;
  }

  // Route handlers.

  getRepoInstallation({ params }: Call): Response {
    const app = this.#actingApp();
    return json(200, {
      id: app.installationId,
      app_id: app.id,
      account: { login: params.owner },
    } satisfies Fixture<Installation>);
  }

  createInstallationToken({ params }: Call): Response {
    const app = this.#actingApp();
    if (Number(params.id) !== app.installationId) return notFound();
    const token = `ghs_${randomBytes(18).toString("hex")}`;
    this.#tokens.set(token, app);
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
      app: { id: this.#actingApp().id, slug: this.#actingApp().slug },
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
    const app = this.#actingApp();
    if (run.app?.id !== app.id) {
      return json(403, { message: `Invalid app_id \`${app.id}\`` });
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
    const head = this.#headOf(params, pull);
    if (body.sha !== undefined && body.sha !== head) {
      return json(409, {
        message: "Head branch was modified. Review and try the merge again.",
      });
    }
    if (
      this.#rulesetBlocks(
        this.#repository(repoOf(params)),
        pull.base?.ref,
        head,
      )
    ) {
      return json(405, {
        message: "Required status checks are not successful.",
      });
    }
    pull.state = "closed";
    pull.merged = true;
    pull.merged_at = timestamp();
    pull.updated_at = pull.merged_at;
    closeLinkedIssues(this.#repository(repoOf(params)), pull.body);
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
    repository.refs.delete(ref);
    return new Response(null, { status: 204 });
  }

  createIssue({ params, body }: Call): Response {
    if (typeof body.title !== "string") return invalid("title is required");
    const repository = this.#repository(repoOf(params));
    const now = timestamp();
    const issue: Fixture<Issue> = {
      id: this.#nextId(),
      number: nextNumber(repository),
      title: body.title,
      body: typeof body.body === "string" ? body.body : "",
      state: "open",
      user:
        this.#actor?.kind === "app"
          ? this.#botUser()
          : { login: "operator", type: "User" },
      created_at: now,
      updated_at: now,
    };
    repository.issues.push(issue);
    return json(201, issue);
  }

  getIssue({ params }: Call): Response {
    const issue = this.#repository(repoOf(params)).issues.find(
      (candidate) => candidate.number === Number(params.number),
    );
    return issue === undefined ? notFound() : json(200, issue);
  }

  createPull({ params, body }: Call): Response {
    const head = typeof body.head === "string" ? body.head : undefined;
    const base = typeof body.base === "string" ? body.base : undefined;
    if (
      typeof body.title !== "string" ||
      head === undefined ||
      base === undefined
    ) {
      return invalid("title, head and base are required");
    }
    const repository = this.#repository(repoOf(params));
    const headSha = repository.refs.get(`heads/${head}`);
    const baseSha = repository.refs.get(`heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      return invalid("head or base is not a branch");
    }
    const number = nextNumber(repository);
    const fullName = repoOf(params);
    const pull: Fixture<PullRequest> = {
      number,
      node_id: `PR_node_${number}`,
      url: `${GitHubSimulator.apiUrl}/repos/${fullName}/pulls/${number}`,
      html_url: `https://github.com/${fullName}/pull/${number}`,
      state: "open",
      merged: false,
      merged_at: null,
      draft: body.draft === true,
      title: body.title,
      body: typeof body.body === "string" ? body.body : "",
      user: this.#botUser(),
      updated_at: timestamp(),
      head: { ref: head, sha: headSha, repo: { full_name: fullName } },
      base: { ref: base, sha: baseSha, repo: { full_name: fullName } },
      requested_reviewers: [],
    };
    repository.pulls.set(number, pull);
    return json(201, pull);
  }

  getRef({ params }: Call): Response {
    const name = params.ref ?? "";
    const sha = this.#repository(repoOf(params)).refs.get(name);
    if (sha === undefined) return notFound();
    return json(200, {
      ref: `refs/${name}`,
      object: { type: "commit", sha },
    });
  }

  createRef({ params, body }: Call): Response {
    if (typeof body.ref !== "string" || !body.ref.startsWith("refs/")) {
      return invalid("ref must start with refs/");
    }
    if (typeof body.sha !== "string") return invalid("sha is required");
    const repository = this.#repository(repoOf(params));
    if (!repository.commits.has(body.sha)) return notFound();
    const name = body.ref.slice("refs/".length);
    if (repository.refs.has(name)) return invalid("Reference already exists");
    repository.refs.set(name, body.sha);
    return json(201, {
      ref: body.ref,
      object: { type: "commit", sha: body.sha },
    });
  }

  updateRef({ params, body }: Call): Response {
    if (typeof body.sha !== "string") return invalid("sha is required");
    const repository = this.#repository(repoOf(params));
    const name = params.ref ?? "";
    if (!repository.refs.has(name)) return notFound();
    if (!repository.commits.has(body.sha)) return notFound();
    repository.refs.set(name, body.sha);
    return json(200, {
      ref: `refs/${name}`,
      object: { type: "commit", sha: body.sha },
    });
  }

  getCommit({ params }: Call): Response {
    const commit = this.#repository(repoOf(params)).commits.get(
      params.sha ?? "",
    );
    return commit === undefined
      ? notFound()
      : json(200, commitResponse(commit));
  }

  createCommit({ params, body }: Call): Response {
    if (typeof body.message !== "string" || typeof body.tree !== "string") {
      return invalid("message and tree are required");
    }
    const repository = this.#repository(repoOf(params));
    if (!repository.trees.has(body.tree)) return notFound();
    const parents = Array.isArray(body.parents)
      ? body.parents.filter(
          (parent): parent is string => typeof parent === "string",
        )
      : [];
    if (parents.some((parent) => !repository.commits.has(parent))) {
      return notFound();
    }
    const sha = this.#writeCommit(repository, body.tree, parents, body.message);
    const commit = repository.commits.get(sha);
    return commit === undefined
      ? notFound()
      : json(201, commitResponse(commit));
  }

  getTree({ params }: Call): Response {
    const tree = this.#repository(repoOf(params)).trees.get(params.sha ?? "");
    if (tree === undefined) return notFound();
    return json(200, treeResponse(this.#repository(repoOf(params)), tree));
  }

  createTree({ params, body }: Call): Response {
    const repository = this.#repository(repoOf(params));
    const baseTree =
      typeof body.base_tree === "string" ? body.base_tree : undefined;
    if (baseTree !== undefined && !repository.trees.has(baseTree))
      return notFound();
    if (!Array.isArray(body.tree)) return invalid("tree is required");
    const files: TreeUpdate[] = [];
    for (const entry of body.tree) {
      const record = asObject(entry);
      if (typeof record.path !== "string")
        return invalid("tree.path is required");
      if (typeof record.content === "string") {
        files.push({ path: record.path, content: record.content });
      } else if (typeof record.sha === "string") {
        if (!repository.blobs.has(record.sha)) return notFound();
        files.push({ path: record.path, sha: record.sha });
      } else {
        return invalid("tree entry needs content or sha");
      }
    }
    const sha = this.#writeTree(repository, baseTree, files);
    const tree = repository.trees.get(sha);
    return tree === undefined
      ? notFound()
      : json(201, treeResponse(repository, tree));
  }

  getBlob({ params }: Call): Response {
    const blob = this.#repository(repoOf(params)).blobs.get(params.sha ?? "");
    if (blob === undefined) return notFound();
    return json(200, {
      sha: blob.sha,
      content: blob.bytes.toString("base64"),
      encoding: "base64",
      size: blob.bytes.length,
    });
  }

  listRulesets({ params }: Call): Response {
    return json(200, this.#repository(repoOf(params)).rulesets);
  }

  createRuleset({ params, body }: Call): Response {
    if (typeof body.name !== "string") return invalid("name is required");
    const repository = this.#repository(repoOf(params));
    const ruleset = storedRuleset(this.#nextId(), body);
    repository.rulesets.push(ruleset);
    return json(201, { ...body, id: ruleset.id, source: repoOf(params) });
  }

  updateRuleset({ params, body }: Call): Response {
    const repository = this.#repository(repoOf(params));
    const id = Number(params.id);
    const index = repository.rulesets.findIndex((ruleset) => ruleset.id === id);
    if (index < 0) return notFound();
    const ruleset = storedRuleset(id, body);
    repository.rulesets[index] = ruleset;
    return json(200, { ...body, id });
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
    const unauthorized = json(401, {
      message: "Bad credentials",
      status: "401",
    });
    if (auth === "app") {
      const credential = credentialOf(headers, "bearer");
      const app =
        credential === undefined ? undefined : this.#appFromJwt(credential);
      if (app === undefined) return unauthorized;
      this.#actor = { kind: "app", app };
      return undefined;
    }
    const credential =
      credentialOf(headers, "token") ?? credentialOf(headers, "bearer");
    if (credential === undefined) return unauthorized;
    if (
      (auth === "operator" || auth === "collaborator") &&
      this.#operatorTokens.has(credential)
    ) {
      this.#actor = { kind: "operator" };
      return undefined;
    }
    if (auth === "operator") return unauthorized;
    const app = this.#tokens.get(credential);
    if (app === undefined) return unauthorized;
    this.#actor = { kind: "app", app };
    return undefined;
  }

  // An App authenticates with a JWT it signs with its private key, issued by
  // its App ID and valid for at most ten minutes.
  #appFromJwt(jwt: string): SimulatedApp | undefined {
    const [header, payload, signature] = jwt.split(".");
    if (header === undefined || payload === undefined || !signature) {
      return undefined;
    }
    let claims: Record<string, unknown>;
    try {
      claims = asObject(
        JSON.parse(Buffer.from(payload, "base64url").toString()),
      );
    } catch {
      return undefined;
    }
    const now = Date.now() / 1000;
    if (
      typeof claims.exp !== "number" ||
      claims.exp <= now ||
      claims.exp - now > 600
    ) {
      return undefined;
    }
    for (const app of this.#apps) {
      if (String(claims.iss) !== String(app.id)) continue;
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${header}.${payload}`);
      if (verifier.verify(app.publicKey, signature, "base64url")) return app;
    }
    return undefined;
  }

  #actingApp(): SimulatedApp {
    if (this.#actor?.kind !== "app") {
      throw new Error("this route ran without an App identity");
    }
    return this.#actor.app;
  }

  // A required check counts only when the latest run of that context on this
  // head, from the bound App, completed with success. A run from another App
  // or on another SHA does not stand in for it.
  #rulesetBlocks(
    repository: Repository,
    base: string | undefined,
    head: string | undefined,
  ): boolean {
    if (head === undefined) return false;
    for (const ruleset of repository.rulesets) {
      if (ruleset.enforcement !== "active") continue;
      if (ruleset.target !== undefined && ruleset.target !== "branch") continue;
      if (!rulesetTargets(ruleset, base)) continue;
      for (const rule of ruleset.rules ?? []) {
        if (rule.type !== "required_status_checks") continue;
        for (const check of rule.parameters?.required_status_checks ?? []) {
          if (!checkSatisfied(repository, head, check)) return true;
        }
      }
    }
    return false;
  }

  #writeTree(
    repository: Repository,
    baseTree: string | undefined,
    files: readonly TreeUpdate[],
  ): string {
    const base =
      baseTree === undefined ? undefined : repository.trees.get(baseTree);
    const entries = new Map(
      (base?.entries ?? []).map((entry) => [entry.path, entry]),
    );
    for (const file of files) {
      const sha =
        file.sha ??
        (file.content === undefined
          ? undefined
          : storeBlob(repository, file.content));
      if (sha === undefined) continue;
      entries.set(file.path, { path: file.path, mode: "100644", sha });
    }
    return storeTree(repository, [...entries.values()]);
  }

  #writeCommit(
    repository: Repository,
    tree: string,
    parents: readonly string[],
    message: string,
  ): string {
    const text = message.endsWith("\n") ? message : `${message}\n`;
    const epoch = Math.floor(Date.now() / 1000);
    const who = `Forgecrew Demo <demo@users.noreply.github.com> ${epoch} +0000`;
    const parentLines = parents.map((parent) => `parent ${parent}\n`).join("");
    const sha = gitSha(
      "commit",
      Buffer.from(
        `tree ${tree}\n${parentLines}author ${who}\ncommitter ${who}\n\n${text}`,
      ),
    );
    repository.commits.set(sha, {
      sha,
      message: text,
      tree,
      parents: [...parents],
    });
    return sha;
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
    const branch = pull.head?.ref;
    if (typeof branch === "string") {
      const sha = this.#repository(repoOf(params)).refs.get(`heads/${branch}`);
      if (sha !== undefined) return sha;
    }
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
        rulesets: [],
        blobs: new Map(),
        trees: new Map(),
        commits: new Map(),
        refs: new Map(),
      };
      this.#repositories.set(path, repository);
    }
    return repository;
  }

  #botUser(): Fixture<PullRequest["user"]> {
    return { login: `${this.#actingApp().slug}[bot]`, type: "Bot" };
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
  /** Further Apps installed on the same repositories. */
  readonly apps?: readonly SimulatedApp[];
  /**
   * Tokens accepted on the operator routes (filing an issue, writing a
   * ruleset). An installation token is not one of these.
   */
  readonly operatorTokens?: readonly string[];
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
  readonly rulesets: StoredRuleset[];
  readonly blobs: Map<string, StoredBlob>;
  readonly trees: Map<string, StoredTree>;
  readonly commits: Map<string, StoredCommit>;
  /** `heads/main` to a commit SHA. */
  readonly refs: Map<string, string>;
}

type Auth = "app" | "installation" | "collaborator" | "operator";

type Actor =
  | { readonly kind: "app"; readonly app: SimulatedApp }
  | { readonly kind: "operator" };
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
  route("POST", "/repos/:owner/:repo/issues", "collaborator", (s, c) =>
    s.createIssue(c),
  ),
  route("GET", "/repos/:owner/:repo/issues/:number", "installation", (s, c) =>
    s.getIssue(c),
  ),
  route("POST", "/repos/:owner/:repo/pulls", "installation", (s, c) =>
    s.createPull(c),
  ),
  route("GET", "/repos/:owner/:repo/git/ref/:ref+", "installation", (s, c) =>
    s.getRef(c),
  ),
  route("POST", "/repos/:owner/:repo/git/refs", "installation", (s, c) =>
    s.createRef(c),
  ),
  route("PATCH", "/repos/:owner/:repo/git/refs/:ref+", "installation", (s, c) =>
    s.updateRef(c),
  ),
  route("GET", "/repos/:owner/:repo/git/commits/:sha", "installation", (s, c) =>
    s.getCommit(c),
  ),
  route("POST", "/repos/:owner/:repo/git/commits", "installation", (s, c) =>
    s.createCommit(c),
  ),
  route("GET", "/repos/:owner/:repo/git/trees/:sha", "installation", (s, c) =>
    s.getTree(c),
  ),
  route("POST", "/repos/:owner/:repo/git/trees", "installation", (s, c) =>
    s.createTree(c),
  ),
  route("GET", "/repos/:owner/:repo/git/blobs/:sha", "installation", (s, c) =>
    s.getBlob(c),
  ),
  route("GET", "/repos/:owner/:repo/rulesets", "operator", (s, c) =>
    s.listRulesets(c),
  ),
  route("POST", "/repos/:owner/:repo/rulesets", "operator", (s, c) =>
    s.createRuleset(c),
  ),
  route("PUT", "/repos/:owner/:repo/rulesets/:id", "operator", (s, c) =>
    s.updateRuleset(c),
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

interface StoredRuleset {
  readonly id: number;
  readonly name?: string;
  readonly target?: string;
  readonly enforcement?: string;
  readonly conditions?: {
    readonly ref_name?: {
      readonly include?: readonly string[];
    };
  };
  readonly rules?: readonly {
    readonly type?: string;
    readonly parameters?: {
      readonly required_status_checks?: readonly {
        readonly context?: string;
        readonly integration_id?: number;
      }[];
    };
  }[];
}

interface StoredBlob {
  readonly sha: string;
  readonly bytes: Buffer;
}

interface TreeEntry {
  readonly path: string;
  readonly mode: "100644";
  readonly sha: string;
}

interface StoredTree {
  readonly sha: string;
  readonly entries: readonly TreeEntry[];
}

interface StoredCommit {
  readonly sha: string;
  readonly message: string;
  readonly tree: string;
  readonly parents: readonly string[];
}

interface TreeUpdate {
  readonly path: string;
  readonly content?: string;
  readonly sha?: string;
}

function storedRuleset(
  id: number,
  body: Record<string, unknown>,
): StoredRuleset {
  const conditions = asObject(body.conditions);
  const refName = asObject(conditions.ref_name);
  const include = Array.isArray(refName.include)
    ? refName.include.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    id,
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.target === "string" ? { target: body.target } : {}),
    ...(typeof body.enforcement === "string"
      ? { enforcement: body.enforcement }
      : {}),
    ...(include === undefined ? {} : { conditions: { ref_name: { include } } }),
    rules: Array.isArray(body.rules) ? body.rules.map(storedRule) : [],
  };
}

function storedRule(
  value: unknown,
): NonNullable<StoredRuleset["rules"]>[number] {
  const rule = asObject(value);
  const parameters = asObject(rule.parameters);
  const checks = Array.isArray(parameters.required_status_checks)
    ? parameters.required_status_checks.map((check) => {
        const item = asObject(check);
        return {
          ...(typeof item.context === "string"
            ? { context: item.context }
            : {}),
          ...(typeof item.integration_id === "number"
            ? { integration_id: item.integration_id }
            : {}),
        };
      })
    : undefined;
  return {
    ...(typeof rule.type === "string" ? { type: rule.type } : {}),
    ...(checks === undefined
      ? {}
      : { parameters: { required_status_checks: checks } }),
  };
}

function rulesetTargets(
  ruleset: StoredRuleset,
  base: string | undefined,
): boolean {
  const include = ruleset.conditions?.ref_name?.include;
  if (include === undefined || include.length === 0) return true;
  if (base === undefined) return false;
  const ref = `refs/heads/${base}`;
  return include.some(
    (pattern) =>
      pattern === ref ||
      pattern === base ||
      pattern === "~DEFAULT_BRANCH" ||
      pattern === "~ALL",
  );
}

function checkSatisfied(
  repository: Repository,
  head: string,
  check: { readonly context?: string; readonly integration_id?: number },
): boolean {
  let latest: Fixture<CheckRun> | undefined;
  for (const run of repository.checkRuns) {
    if (run.head_sha !== head || run.name !== check.context) continue;
    if (
      check.integration_id !== undefined &&
      run.app?.id !== check.integration_id
    ) {
      continue;
    }
    if (latest === undefined || (run.id ?? 0) > (latest.id ?? 0)) latest = run;
  }
  return latest?.status === "completed" && latest.conclusion === "success";
}

function closeLinkedIssues(
  repository: Repository,
  body: string | null | undefined,
): void {
  if (typeof body !== "string") return;
  for (const match of body.matchAll(
    /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/gi,
  )) {
    const number = Number(match[1]);
    const issue = repository.issues.find((item) => item.number === number);
    if (issue !== undefined && issue.state !== "closed") {
      const now = timestamp();
      issue.state = "closed";
      issue.closed_at = now;
      issue.updated_at = now;
    }
  }
}

function nextNumber(repository: Repository): number {
  const numbers = [
    ...repository.pulls.keys(),
    ...repository.issues.map((issue) => issue.number ?? 0),
  ];
  return Math.max(0, ...numbers) + 1;
}

function storeBlob(repository: Repository, content: string): string {
  const bytes = Buffer.from(content, "utf8");
  const sha = gitSha("blob", bytes);
  repository.blobs.set(sha, { sha, bytes });
  return sha;
}

function storeTree(
  repository: Repository,
  entries: readonly TreeEntry[],
): string {
  const sorted = entries.toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.path}\0`));
    chunks.push(Buffer.from(entry.sha, "hex"));
  }
  const sha = gitSha("tree", Buffer.concat(chunks));
  repository.trees.set(sha, { sha, entries: sorted });
  return sha;
}

function gitSha(type: string, payload: Buffer): string {
  const header = Buffer.from(`${type} ${payload.length}\0`);
  return createHash("sha1")
    .update(Buffer.concat([header, payload]))
    .digest("hex");
}

function commitResponse(commit: StoredCommit): {
  sha: string;
  message: string;
  tree: { sha: string };
  parents: { sha: string }[];
} {
  return {
    sha: commit.sha,
    message: commit.message,
    tree: { sha: commit.tree },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

function treeResponse(
  repository: Repository,
  tree: StoredTree,
): {
  sha: string;
  truncated: false;
  tree: {
    path: string;
    mode: "100644";
    type: "blob";
    sha: string;
    size: number;
  }[];
} {
  return {
    sha: tree.sha,
    truncated: false,
    tree: tree.entries.map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      type: "blob" as const,
      sha: entry.sha,
      size: repository.blobs.get(entry.sha)?.bytes.length ?? 0,
    })),
  };
}

function credentialOf(headers: Headers, scheme: string): string | undefined {
  const [presented, credential] = (headers.get("authorization") ?? "").split(
    " ",
  );
  if (
    presented?.toLowerCase() !== scheme ||
    credential === undefined ||
    credential === ""
  ) {
    return undefined;
  }
  return credential;
}
