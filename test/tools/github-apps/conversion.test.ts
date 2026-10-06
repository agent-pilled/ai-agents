import { format, inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversionError,
  convertManifestCode,
} from "../../../tools/github-apps/conversion.ts";
import {
  FAKE_APP,
  FAKE_PRIVATE_KEY,
  FAKE_SECRETS,
  fakeConversionBody,
  type StubGithub,
  type StubOptions,
  startStubGithub,
} from "./support/stub-github.ts";

const stubs: StubGithub[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
});

async function stubGithub(options?: StubOptions): Promise<StubGithub> {
  const stub = await startStubGithub(options);
  stubs.push(stub);
  return stub;
}

describe("exchanging the manifest code", () => {
  it("posts the code to the conversion endpoint without credentials", async () => {
    const stub = await stubGithub();

    await convertManifestCode("code-1", { apiBaseUrl: stub.url });

    expect(stub.requests).toHaveLength(1);
    const [request] = stub.requests;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/app-manifests/code-1/conversions");
    expect(request?.headers.accept).toBe("application/vnd.github+json");
    expect(request?.headers["user-agent"]).toMatch(/forgecrew/);
    // The temporary code is the credential; no token goes with it.
    expect(request?.headers).not.toHaveProperty("authorization");
  });

  it("returns the App's id, slug, name and private key", async () => {
    const stub = await stubGithub();

    const app = await convertManifestCode("code-1", { apiBaseUrl: stub.url });

    expect(app.id).toBe(FAKE_APP.id);
    expect(app.slug).toBe(FAKE_APP.slug);
    expect(app.name).toBe(FAKE_APP.name);
    expect(app.privateKey.reveal()).toBe(FAKE_PRIVATE_KEY);
  });

  it("drops the client secret and the webhook secret, and hides the key from logs", async () => {
    const stub = await stubGithub();

    const app = await convertManifestCode("code-1", { apiBaseUrl: stub.url });

    const renderings = [
      JSON.stringify(app),
      inspect(app, { depth: 10 }),
      format("%o", app),
      `${app.privateKey}`,
    ].join("\n");
    for (const secret of FAKE_SECRETS) {
      expect(renderings).not.toContain(secret);
    }
  });

  it("encodes the code in the request path", async () => {
    const stub = await stubGithub({
      conversion: () => ({ status: 201, body: fakeConversionBody() }),
    });

    await convertManifestCode("a/b?c", { apiBaseUrl: stub.url });

    expect(stub.requests[0]?.path).toBe("/app-manifests/a%2Fb%3Fc/conversions");
  });

  it.each([
    [
      404,
      { message: "Not Found" },
      /404.*Not Found/s,
      /expired|already been used/,
    ],
    [
      422,
      { message: "Validation Failed" },
      /422.*Validation Failed/s,
      /called too often/,
    ],
  ])(
    "explains a %i answer without echoing the body",
    async (status, body, shown, hint) => {
      const decoy = { ...body, echoed: FAKE_SECRETS[1] };
      const stub = await stubGithub({
        conversion: () => ({ status, body: decoy }),
      });

      const failure = await convertManifestCode("code-1", {
        apiBaseUrl: stub.url,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConversionError);
      const message = (failure as ConversionError).message;
      expect(message).toMatch(shown);
      expect(message).toMatch(hint);
      expect(message).not.toContain(FAKE_SECRETS[1]);
    },
  );

  it("refuses an answer that lacks the private key, without quoting it", async () => {
    const { pem: _pem, ...withoutKey } = fakeConversionBody();
    const stub = await stubGithub({
      conversion: () => ({ status: 201, body: withoutKey }),
    });

    const failure = await convertManifestCode("code-1", {
      apiBaseUrl: stub.url,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConversionError);
    expect((failure as ConversionError).message).toMatch(/expected fields/);
    for (const secret of FAKE_SECRETS) {
      expect((failure as ConversionError).message).not.toContain(secret);
    }
  });

  it.each([
    ["is not JSON", "<html>oops</html>"],
    [
      "has an id that is not a positive integer",
      { ...fakeConversionBody(), id: "7" },
    ],
    ["has a key that is not a PEM", { ...fakeConversionBody(), pem: "nope" }],
  ])("refuses a 201 answer that %s", async (_why, body) => {
    const stub = await stubGithub({
      conversion: () => ({ status: 201, body }),
    });

    await expect(
      convertManifestCode("code-1", { apiBaseUrl: stub.url }),
    ).rejects.toThrow(ConversionError);
  });

  it.each([
    ["a path-like slug", "../escape"],
    ["a slug with characters GitHub may keep", "my_bot.v2"],
    ["no slug at all", undefined],
  ])("keeps the key when the answer has %s", async (_why, slug) => {
    const stub = await stubGithub({
      conversion: () => ({
        status: 201,
        body: { ...fakeConversionBody(), slug },
      }),
    });

    const app = await convertManifestCode("code-1", { apiBaseUrl: stub.url });

    // The slug only names files and builds a link; losing the key over it would
    // leave an App that nobody can use.
    expect(app.id).toBe(FAKE_APP.id);
    expect(app.privateKey.reveal()).toBe(FAKE_PRIVATE_KEY);
    expect(app.slug).toBeUndefined();
  });

  it("keeps the key when the answer has no name", async () => {
    const { name: _name, ...withoutName } = fakeConversionBody();
    const stub = await stubGithub({
      conversion: () => ({ status: 201, body: withoutName }),
    });

    const app = await convertManifestCode("code-1", { apiBaseUrl: stub.url });

    expect(app.name).toBeUndefined();
    expect(app.privateKey.reveal()).toBe(FAKE_PRIVATE_KEY);
  });

  it("marks a timeout, an unreachable GitHub and a server error as worth retrying, and refusals as final", async () => {
    const hanging = await stubGithub({ conversion: () => "hang" });
    const timedOut = await convertManifestCode("code-1", {
      apiBaseUrl: hanging.url,
      timeoutMs: 50,
    }).catch((error: unknown) => error);
    const closed = await stubGithub();
    await closed.close();
    const unreachable = await convertManifestCode("code-1", {
      apiBaseUrl: closed.url,
    }).catch((error: unknown) => error);
    const failing = await stubGithub({
      conversion: () => ({
        status: 503,
        body: { message: "Service Unavailable" },
      }),
    });
    const serverError = await convertManifestCode("code-1", {
      apiBaseUrl: failing.url,
    }).catch((error: unknown) => error);
    const refusing = await stubGithub({
      conversion: () => ({ status: 404, body: { message: "Not Found" } }),
    });
    const refused = await convertManifestCode("code-1", {
      apiBaseUrl: refusing.url,
    }).catch((error: unknown) => error);
    const malformed = await stubGithub({
      conversion: () => ({ status: 201, body: "<html>oops</html>" }),
    });
    const unreadable = await convertManifestCode("code-1", {
      apiBaseUrl: malformed.url,
    }).catch((error: unknown) => error);

    expect((timedOut as ConversionError).retryable).toBe(true);
    expect((unreachable as ConversionError).retryable).toBe(true);
    expect((serverError as ConversionError).retryable).toBe(true);
    expect((refused as ConversionError).retryable).toBe(false);
    expect((unreadable as ConversionError).retryable).toBe(false);
  });

  // GitHub answers a request over its rate limit with 403 or 429, marked by
  // x-ratelimit-remaining: 0 or by retry-after, and the manifest guide says this
  // endpoint is rate limited. That request did no work, so the code is probably
  // unused, and a reload costs nothing if it is not:
  // https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
  it.each([
    [429, {}, true],
    [403, { "x-ratelimit-remaining": "0" }, true],
    [403, { "retry-after": "60" }, true],
    [403, { "x-ratelimit-remaining": "17" }, false],
    [403, {}, false],
    [401, { "x-ratelimit-remaining": "0" }, false],
  ])(
    "treats a %i answer with headers %j as worth retrying: %s",
    async (status, headers, retryable) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status,
          headers,
        }),
      );

      const failure = await convertManifestCode("code-1", {
        apiBaseUrl: "http://github.invalid",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConversionError);
      expect((failure as ConversionError).retryable).toBe(retryable);
    },
  );

  it("describes a failure without telling the operator what to do next, which depends on whether the App exists", async () => {
    const stub = await stubGithub({
      conversion: () => ({ status: 404, body: { message: "Not Found" } }),
    });

    const failure = await convertManifestCode("code-1", {
      apiBaseUrl: stub.url,
    }).catch((error: unknown) => error);

    expect((failure as ConversionError).message).not.toMatch(/start again/i);
    expect((failure as ConversionError).message).not.toMatch(/generate/i);
  });

  it("reports an unreachable GitHub", async () => {
    const stub = await stubGithub();
    await stub.close();

    await expect(
      convertManifestCode("code-1", { apiBaseUrl: stub.url }),
    ).rejects.toThrow(/Could not reach GitHub/);
  });

  it("gives up on an answer that never comes", async () => {
    const stub = await stubGithub({ conversion: () => "hang" });

    await expect(
      convertManifestCode("code-1", { apiBaseUrl: stub.url, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/i);
  });
});
