import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppManifest,
  buildManifest,
  permissionGrants,
} from "../../../tools/github-apps/manifests.ts";
import type { RegistrationParameters } from "../../../tools/github-apps/parameters.ts";
import {
  loopbackHosts,
  type RegistrationDeps,
  RegistrationError,
  type RegistrationSession,
  startRegistration,
} from "../../../tools/github-apps/registration.ts";
import {
  FAKE_APP,
  FAKE_PRIVATE_KEY,
  FAKE_SECRETS,
  fakeConversionBody,
  type StubGithub,
  type StubOptions,
  startStubGithub,
} from "./support/stub-github.ts";

// The tests play the browser: they open the helper's page, post its form to the
// stub that stands in for GitHub, and follow the redirect back with a code.

let stub: StubGithub;
const sessions: RegistrationSession[] = [];
const dirs: string[] = [];

beforeEach(async () => {
  stub = await startStubGithub();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await stub.close();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forgecrew-registration-"));
  dirs.push(dir);
  return dir;
}

const baseParameters: Omit<RegistrationParameters, "outDir"> = {
  kind: "review-bot",
  name: "Example Review Bot",
  org: undefined,
  homepageUrl: "https://example.test/forgecrew",
  port: 0,
};

async function begin(
  overrides: Partial<RegistrationParameters> = {},
  deps: Partial<RegistrationDeps> = {},
  github: StubGithub = stub,
): Promise<{ session: RegistrationSession; outDir: string }> {
  const outDir = await tempDir();
  const session = await startRegistration(
    { ...baseParameters, outDir, ...overrides },
    {
      endpoints: { webBaseUrl: github.url, apiBaseUrl: github.url },
      timeoutMs: 5_000,
      ...deps,
    },
  );
  sessions.push(session);
  return { session, outDir };
}

function decode(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

async function openPage(session: RegistrationSession) {
  const response = await fetch(session.url);
  const html = await response.text();
  const action = decode(
    /<form method="post" action="([^"]*)">/.exec(html)?.[1] ?? "",
  );
  const manifestJson = decode(
    /name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? "",
  );
  return {
    response,
    html,
    action,
    manifest: JSON.parse(manifestJson) as AppManifest,
    state: new URL(action).searchParams.get("state") ?? "",
  };
}

function redirectBack(
  manifest: AppManifest,
  query: { code?: string; state?: string },
): Promise<Response> {
  const url = new URL(manifest.redirect_url);
  if (query.code !== undefined) url.searchParams.set("code", query.code);
  if (query.state !== undefined) url.searchParams.set("state", query.state);
  return fetch(url);
}

function getWithHost(url: string, host: string, path: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: target.hostname, port: target.port, path, headers: { host } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function filesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe("the registration page", () => {
  it("posts the review-bot manifest to GitHub for a personal account", async () => {
    const { session } = await begin();

    const page = await openPage(session);

    expect(page.response.status).toBe(200);
    expect(page.response.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.action).toBe(
      `${stub.url}/settings/apps/new?state=${page.state}`,
    );
    expect(page.manifest).toEqual(
      buildManifest({
        kind: "review-bot",
        name: baseParameters.name,
        homepageUrl: baseParameters.homepageUrl,
        redirectUrl: `${session.url}callback`,
      }),
    );
    expect(page.html).toContain("personal GitHub account");
  });

  it("posts to the organization's page when an organization is given", async () => {
    const { session } = await begin({ org: "example-org", kind: "scheduler" });

    const page = await openPage(session);

    expect(page.action).toBe(
      `${stub.url}/organizations/example-org/settings/apps/new?state=${page.state}`,
    );
    expect(page.manifest.default_permissions).toEqual(
      buildManifest({
        kind: "scheduler",
        name: "x",
        homepageUrl: "https://x.test/",
        redirectUrl: "http://127.0.0.1/",
      }).default_permissions,
    );
    expect(page.html).toContain("example-org");
  });

  it("redirects to the loopback address it listens on, and only there", async () => {
    const { session } = await begin();

    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const { manifest } = await openPage(session);
    expect(manifest.redirect_url).toBe(`${session.url}callback`);
  });

  it("uses a different unguessable state for every registration", async () => {
    const first = await openPage((await begin()).session);
    const second = await openPage((await begin()).session);

    expect(first.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(second.state).not.toBe(first.state);
  });

  it("lists every permission with its reason, so the operator can compare it with GitHub's page", async () => {
    const { session } = await begin();

    const { html } = await openPage(session);

    const text = decode(html);
    for (const grant of permissionGrants("review-bot")) {
      expect(text).toContain(grant.permission);
      expect(text).toContain(grant.why);
    }
  });

  it("runs no script and loads nothing", async () => {
    const { session } = await begin();

    const { html, response } = await openPage(session);

    expect(html).not.toMatch(/<script/i);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("escapes what it shows, even for values that validation would have refused", async () => {
    const hostile = `"><script>alert(1)</script>`;
    const { session } = await begin({
      name: hostile,
      homepageUrl: "https://example.test/?a=1&b='2'",
    });

    const { html, manifest } = await openPage(session);

    expect(html).not.toContain("<script>");
    expect(manifest.name).toBe(hostile);
    expect(manifest.url).toBe("https://example.test/?a=1&b='2'");
  });

  it("rejects a request whose Host header is not the loopback address", async () => {
    const { session } = await begin();

    const status = await getWithHost(session.url, "attacker.example", "/");

    expect(status).toBe(403);
  });

  it("answers 404 for other paths", async () => {
    const { session } = await begin();

    const response = await fetch(`${session.url}elsewhere`);

    expect(response.status).toBe(404);
  });
});

describe("the redirect from GitHub", () => {
  it("exchanges the code, saves the credentials and ends the registration", async () => {
    const { session, outDir } = await begin();
    const page = await openPage(session);
    await fetch(page.action, {
      method: "POST",
      body: new URLSearchParams({ manifest: JSON.stringify(page.manifest) }),
    });

    const response = await redirectBack(page.manifest, {
      code: "code-1",
      state: page.state,
    });
    const result = await session.done;

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("App created");
    expect(result).toEqual({
      appId: FAKE_APP.id,
      slug: FAKE_APP.slug,
      name: FAKE_APP.name,
      appIdPath: join(outDir, "example-review-bot-424242.app-id"),
      privateKeyPath: join(outDir, "example-review-bot-424242.private-key.pem"),
      installUrl: `${stub.url}/apps/example-review-bot/installations/new`,
    });
    expect(await readFile(result.privateKeyPath, "utf8")).toBe(
      FAKE_PRIVATE_KEY,
    );
    expect(await readFile(result.appIdPath, "utf8")).toBe("424242\n");
    expect((await stat(result.privateKeyPath)).mode & 0o777).toBe(0o600);
    const conversions = stub.requests.filter((r) =>
      r.path.includes("conversions"),
    );
    expect(conversions.map((r) => r.path)).toEqual([
      "/app-manifests/code-1/conversions",
    ]);
    // The posted form is what GitHub would have received.
    expect(stub.requests[0]?.path).toBe(
      `/settings/apps/new?state=${page.state}`,
    );
    expect(stub.requests[0]?.body).toContain("manifest=");
  });

  it("shows the next steps without any secret", async () => {
    const { session } = await begin();
    const page = await openPage(session);

    const response = await redirectBack(page.manifest, {
      code: "code-1",
      state: page.state,
    });
    const body = decode(await response.text());
    await session.done;

    expect(body).toContain("example-review-bot-424242.private-key.pem");
    expect(body).toMatch(/keychain/);
    expect(body).toMatch(/delete the file/);
    expect(body).toContain(
      `${stub.url}/apps/example-review-bot/installations/new`,
    );
    for (const secret of FAKE_SECRETS) expect(body).not.toContain(secret);
  });

  it("stops listening once it is done", async () => {
    const { session } = await begin();
    const page = await openPage(session);
    await redirectBack(page.manifest, { code: "code-1", state: page.state });
    await session.done;

    await expect(fetch(session.url)).rejects.toThrow();
  });

  it.each([
    ["a wrong state", { code: "code-1", state: "not-the-state" }],
    ["no state", { code: "code-1" }],
    ["a state of another length", { code: "code-1", state: "x".repeat(500) }],
  ])(
    "ignores a redirect with %s, and still accepts the real one",
    async (_why, query) => {
      const { session, outDir } = await begin();
      const page = await openPage(session);

      const forged = await redirectBack(page.manifest, query);

      expect(forged.status).toBe(400);
      expect(stub.requests).toEqual([]);
      expect(await filesIn(outDir)).toEqual([]);

      await redirectBack(page.manifest, { code: "code-1", state: page.state });
      expect((await session.done).appId).toBe(FAKE_APP.id);
    },
  );

  it("answers 400 to a redirect without a code", async () => {
    const { session } = await begin();
    const page = await openPage(session);

    const response = await redirectBack(page.manifest, { state: page.state });

    expect(response.status).toBe(400);
    expect(stub.requests).toEqual([]);
  });

  it("rejects a redirect whose Host header is not the loopback address", async () => {
    const { session } = await begin();
    const page = await openPage(session);

    const status = await getWithHost(
      session.url,
      "attacker.example",
      `/callback?code=code-1&state=${page.state}`,
    );

    expect(status).toBe(403);
    expect(stub.requests).toEqual([]);
  });
});

describe("a failed registration", () => {
  async function failedConversion(): Promise<{
    response: Response;
    failure: unknown;
    outDir: string;
    session: RegistrationSession;
  }> {
    const github = await startStubGithub({
      conversion: () => ({
        status: 404,
        body: { message: "Not Found", echoed: FAKE_SECRETS[1] },
      }),
    } satisfies StubOptions);
    try {
      const { session, outDir } = await begin({}, {}, github);
      const page = await openPage(session);
      const response = await redirectBack(page.manifest, {
        code: "code-1",
        state: page.state,
      });
      const failure = await session.done.catch((error: unknown) => error);
      return { response, failure, outDir, session };
    } finally {
      await github.close();
    }
  }

  it("reports a refused conversion to the browser and the caller, and saves nothing", async () => {
    const { response, failure, outDir } = await failedConversion();

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Not Found");
    expect(failure).toBeInstanceOf(RegistrationError);
    expect((failure as RegistrationError).message).toMatch(/404/);
    expect(await filesIn(outDir)).toEqual([]);
  });

  it("tells the operator that the App already exists, because the redirect comes only after Create", async () => {
    const { response, failure } = await failedConversion();

    const advice =
      /already created the App.*same name will fail.*generate a private key.*delete the App/s;
    expect((failure as RegistrationError).message).toMatch(advice);
    expect((failure as RegistrationError).message).toMatch(
      /\/settings\/apps\b/,
    );
    expect(await response.text()).toMatch(/already created the App/);
  });

  it("sends an organization's operator to the organization's list of Apps", async () => {
    const github = await startStubGithub({
      conversion: () => ({ status: 201, body: { id: 7 } }),
    });
    try {
      const { session } = await begin({ org: "example-org" }, {}, github);
      const page = await openPage(session);
      await redirectBack(page.manifest, { code: "code-1", state: page.state });

      const failure = await session.done.catch((error: unknown) => error);

      expect((failure as RegistrationError).message).toContain(
        `${github.url}/organizations/example-org/settings/apps`,
      );
      expect((failure as RegistrationError).message).toMatch(/expected fields/);
    } finally {
      await github.close();
    }
  });

  it("keeps the key when GitHub's slug cannot be used, and files it by ID", async () => {
    const github = await startStubGithub({
      conversion: () => ({
        status: 201,
        body: { ...fakeConversionBody(), slug: "my_bot.v2" },
      }),
    });
    try {
      const { session, outDir } = await begin({}, {}, github);
      const page = await openPage(session);

      const response = await redirectBack(page.manifest, {
        code: "code-1",
        state: page.state,
      });
      const result = await session.done;

      expect(response.status).toBe(200);
      expect(result.slug).toBeUndefined();
      expect(await filesIn(outDir)).toEqual([
        "app-424242.app-id",
        "app-424242.private-key.pem",
      ]);
      expect(await readFile(result.privateKeyPath, "utf8")).toBe(
        FAKE_PRIVATE_KEY,
      );
      // Without a slug there is no direct install link; the list has the App.
      expect(result.installUrl).toBe(`${github.url}/settings/apps`);
      expect(decode(await response.text())).toMatch(/list of GitHub Apps/);
    } finally {
      await github.close();
    }
  });

  it("lets the operator reload after a dropped connection, because the code is still unused", async () => {
    let calls = 0;
    const github = await startStubGithub({
      conversion: () => {
        calls += 1;
        return calls === 1
          ? "drop"
          : { status: 201, body: fakeConversionBody() };
      },
    });
    try {
      const { session, outDir } = await begin({}, {}, github);
      const page = await openPage(session);

      const first = await redirectBack(page.manifest, {
        code: "code-1",
        state: page.state,
      });

      expect(first.status).toBe(502);
      const reloadPage = decode(await first.text());
      expect(reloadPage).toMatch(/Reload this page/);
      // The operator may give up instead of reloading, so the page already says
      // that the App exists and where to deal with it.
      expect(reloadPage).toMatch(/already created the App/);
      expect(reloadPage).toMatch(/same name will fail/);
      expect(reloadPage).toContain(`${github.url}/settings/apps`);
      expect(await filesIn(outDir)).toEqual([]);
      const pending = await Promise.race([
        session.done.then(() => "settled"),
        sleep(100).then(() => "pending"),
      ]);
      expect(pending).toBe("pending");

      const second = await redirectBack(page.manifest, {
        code: "code-1",
        state: page.state,
      });

      expect(second.status).toBe(200);
      expect((await session.done).appId).toBe(FAKE_APP.id);
      expect(calls).toBe(2);
      expect(await filesIn(outDir)).toHaveLength(2);
    } finally {
      await github.close();
    }
  });

  it("lets the operator reload after a server error from GitHub", async () => {
    let calls = 0;
    const github = await startStubGithub({
      conversion: () => {
        calls += 1;
        return calls === 1
          ? { status: 503, body: { message: "Service Unavailable" } }
          : { status: 201, body: fakeConversionBody() };
      },
    });
    try {
      const { session, outDir } = await begin({}, {}, github);
      const page = await openPage(session);

      const first = await redirectBack(page.manifest, {
        code: "code-1",
        state: page.state,
      });

      expect(first.status).toBe(502);
      expect(decode(await first.text())).toMatch(/503.*Reload this page/s);
      const second = await redirectBack(page.manifest, {
        code: "code-1",
        state: page.state,
      });

      expect(second.status).toBe(200);
      expect((await session.done).appId).toBe(FAKE_APP.id);
      expect(await filesIn(outDir)).toHaveLength(2);
    } finally {
      await github.close();
    }
  });

  it("starts no timeout once the session has been closed during an exchange", async () => {
    let release: (answer: "drop") => void = () => undefined;
    const held = new Promise<"drop">((resolve) => {
      release = resolve;
    });
    const github = await startStubGithub({ conversion: () => held });
    // A timeout nobody clears would keep the process alive for its whole
    // length, so follow the helper's own timers, found by their unusual delay.
    const delay = 7_777;
    const started = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      const { session } = await begin({}, { timeoutMs: delay }, github);
      const page = await openPage(session);
      const browser = redirectBack(page.manifest, {
        code: "code-1",
        state: page.state,
      }).catch(() => undefined);
      await vi.waitFor(() => {
        expect(
          github.requests.some((r) => r.path.includes("conversions")),
        ).toBe(true);
      });

      await session.close();
      release("drop");
      await browser;
      await sleep(100);

      const live = started.mock.calls
        .map((call, index) => ({
          delay: call[1],
          handle: started.mock.results[index]?.value,
        }))
        .filter((timer) => timer.delay === delay)
        .map((timer) => timer.handle)
        .filter(
          (handle) =>
            !cleared.mock.calls.some(([cleared]) => cleared === handle),
        );
      for (const handle of live) clearTimeout(handle);
      expect(live).toEqual([]);
    } finally {
      await github.close();
    }
  });

  it("keeps the timeout running while it waits for a reload", async () => {
    const github = await startStubGithub({ conversion: () => "drop" });
    try {
      const { session } = await begin({}, { timeoutMs: 200 }, github);
      const page = await openPage(session);

      await redirectBack(page.manifest, { code: "code-1", state: page.state });

      await expect(session.done).rejects.toThrow(/Timed out/);
    } finally {
      await github.close();
    }
  });

  it("never echoes the body of a refused conversion", async () => {
    const { response, failure } = await failedConversion();

    expect(await response.text()).not.toContain(FAKE_SECRETS[1]);
    expect((failure as RegistrationError).message).not.toContain(
      FAKE_SECRETS[1],
    );
  });

  it("explains how to recover when the credentials cannot be saved after the App exists", async () => {
    const { session, outDir } = await begin({ org: "example-org" });
    const page = await openPage(session);
    await writeFile(
      join(outDir, "example-review-bot-424242.private-key.pem"),
      "an older key\n",
    );

    const response = await redirectBack(page.manifest, {
      code: "code-1",
      state: page.state,
    });
    const failure = await session.done.catch((error: unknown) => error);

    expect(response.status).toBe(500);
    expect(failure).toBeInstanceOf(RegistrationError);
    const message = (failure as RegistrationError).message;
    expect(message).toMatch(/GitHub created the App/);
    expect(message).toMatch(/cannot be fetched again/);
    expect(message).toContain(
      `${stub.url}/organizations/example-org/settings/apps/example-review-bot`,
    );
    expect(message).not.toContain(FAKE_PRIVATE_KEY.split("\n")[1]);
    expect(
      await readFile(
        join(outDir, "example-review-bot-424242.private-key.pem"),
        "utf8",
      ),
    ).toBe("an older key\n");
  });

  it("does not let the timeout cut an exchange short once the redirect has arrived", async () => {
    const github = await startStubGithub({
      conversion: () => ({
        status: 201,
        body: fakeConversionBody(),
        delayMs: 400,
      }),
    });
    try {
      const { session, outDir } = await begin({}, { timeoutMs: 150 }, github);
      const page = await openPage(session);

      await redirectBack(page.manifest, { code: "code-1", state: page.state });

      expect((await session.done).appId).toBe(FAKE_APP.id);
      expect(await filesIn(outDir)).toHaveLength(2);
    } finally {
      await github.close();
    }
  });

  it("gives up when GitHub never redirects back", async () => {
    const { session } = await begin({}, { timeoutMs: 30 });

    await expect(session.done).rejects.toThrow(/Timed out/);
    await expect(fetch(session.url)).rejects.toThrow();
  });

  it("warns that an App created after the helper gave up still exists", async () => {
    const { session } = await begin({ org: "example-org" }, { timeoutMs: 30 });

    const failure = await session.done.catch((error: unknown) => error);

    const message = (failure as RegistrationError).message;
    expect(message).toMatch(/If you clicked Create GitHub App/);
    expect(message).toContain(
      `${stub.url}/organizations/example-org/settings/apps`,
    );
  });

  it("refuses an output directory that cannot take the files, before listening", async () => {
    const dir = await tempDir();
    const file = join(dir, "a-file");
    await writeFile(file, "");

    await expect(
      startRegistration(
        { ...baseParameters, outDir: file },
        { endpoints: { webBaseUrl: stub.url, apiBaseUrl: stub.url } },
      ),
    ).rejects.toThrow(RegistrationError);
  });

  it("names a port that is already taken", async () => {
    const { session } = await begin();
    const port = Number(new URL(session.url).port);

    await expect(begin({ port })).rejects.toThrow(
      new RegExp(`Port ${port} is already in use`),
    );
  });

  it("can be closed by the caller", async () => {
    const { session } = await begin();

    await session.close();

    await expect(session.done).rejects.toThrow(/cancelled/);
    await expect(fetch(session.url)).rejects.toThrow();
  });
});

describe("the hosts the helper answers to", () => {
  it("are the loopback address and localhost with the port", () => {
    expect([...loopbackHosts(8123)].sort()).toEqual([
      "127.0.0.1:8123",
      "localhost:8123",
    ]);
  });

  it("drop the port for 80, which is how a browser writes the Host header of an http URL", () => {
    // new URL("http://127.0.0.1:80/").host is "127.0.0.1": browsers omit the
    // default port, so a Host of "127.0.0.1:80" would never arrive.
    expect([...loopbackHosts(80)].sort()).toEqual(["127.0.0.1", "localhost"]);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
