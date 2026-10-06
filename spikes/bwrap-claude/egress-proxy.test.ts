import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEgressProxy,
  type EgressLogEntry,
  formatTarget,
  parseAllowList,
  parseTarget,
} from "./egress-proxy.ts";
import {
  cleanUp,
  closed,
  closedPort,
  connected,
  eventually,
  listen,
  onCleanUp,
  readBytes,
  readHead,
  startTcpEcho,
  tempDir,
} from "./test-support.ts";

afterEach(cleanUp);

describe("the egress proxy", () => {
  it("tunnels to an allowed target and logs the attempt and the closed tunnel", async () => {
    const upstream = await startTcpEcho();
    const target = `127.0.0.1:${upstream.port}`;
    const { socketPath, logs } = await startProxy([target]);

    const client = await connected(connect(socketPath));
    client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    expect(statusLine(await readHead(client))).toBe(
      "HTTP/1.1 200 Connection Established",
    );
    client.write("ping");
    expect(await readBytes(client, 4)).toBe("ping");
    client.end();
    await eventually(() => logs.some((entry) => entry.event === "closed"));

    expect(logs).toEqual([
      {
        time: expect.any(String),
        id: 1,
        event: "attempt",
        method: "CONNECT",
        target,
        decision: "allow",
      },
      {
        time: expect.any(String),
        id: 1,
        event: "closed",
        target,
        bytesUp: 4,
        bytesDown: 4,
        durationMs: expect.any(Number),
      },
    ]);
  });

  it("refuses a target that is not on the allowlist, without contacting it", async () => {
    const allowed = await startTcpEcho();
    const other = await startTcpEcho();
    const { socketPath, logs } = await startProxy([
      `127.0.0.1:${allowed.port}`,
    ]);

    const target = `127.0.0.1:${other.port}`;
    const head = await exchange(
      socketPath,
      `CONNECT ${target} HTTP/1.1\r\n\r\n`,
    );

    expect(statusLine(head)).toBe("HTTP/1.1 403 Forbidden");
    expect(other.connections()).toBe(0);
    expect(logs).toEqual([
      {
        time: expect.any(String),
        id: 1,
        event: "attempt",
        method: "CONNECT",
        target,
        decision: "deny",
        reason: "not-allowed",
      },
    ]);
  });

  it("refuses requests other than CONNECT and logs only their host and port", async () => {
    const { socketPath, logs } = await startProxy(["example.com:443"]);

    const head = await exchange(
      socketPath,
      "GET http://example.com/secret?token=abc HTTP/1.1\r\nHost: example.com\r\n\r\n",
    );

    expect(statusLine(head)).toBe("HTTP/1.1 405 Method Not Allowed");
    expect(logs).toEqual([
      {
        time: expect.any(String),
        id: 1,
        event: "attempt",
        method: "GET",
        target: "example.com:80",
        decision: "deny",
        reason: "method-not-allowed",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("secret");
  });

  it("refuses a CONNECT target it cannot parse", async () => {
    const { socketPath, logs } = await startProxy(["example.com:443"]);

    const head = await exchange(
      socketPath,
      "CONNECT example.com HTTP/1.1\r\n\r\n",
    );

    expect(statusLine(head)).toBe("HTTP/1.1 400 Bad Request");
    expect(logs).toEqual([
      {
        time: expect.any(String),
        id: 1,
        event: "attempt",
        method: "CONNECT",
        target: null,
        decision: "deny",
        reason: "bad-target",
      },
    ]);
  });

  it("refuses and logs a request it cannot parse as HTTP", async () => {
    const { socketPath, logs } = await startProxy(["example.com:443"]);

    const head = await exchange(socketPath, "HELLO\r\n\r\n");

    expect(statusLine(head)).toBe("HTTP/1.1 400 Bad Request");
    expect(logs).toEqual([
      {
        time: expect.any(String),
        id: 1,
        event: "attempt",
        method: null,
        target: null,
        decision: "deny",
        reason: "bad-request",
      },
    ]);
  });

  it("answers 502 and logs the error when an allowed upstream refuses", async () => {
    const target = `127.0.0.1:${await closedPort()}`;
    const { socketPath, logs } = await startProxy([target]);

    const head = await exchange(
      socketPath,
      `CONNECT ${target} HTTP/1.1\r\n\r\n`,
    );

    expect(statusLine(head)).toBe("HTTP/1.1 502 Bad Gateway");
    expect(logs).toEqual([
      {
        time: expect.any(String),
        id: 1,
        event: "attempt",
        method: "CONNECT",
        target,
        decision: "allow",
      },
      {
        time: expect.any(String),
        id: 1,
        event: "upstream-error",
        target,
        error: "ECONNREFUSED",
      },
    ]);
  });

  it("numbers attempts in order", async () => {
    const { socketPath, logs } = await startProxy(["example.com:443"]);

    await exchange(socketPath, "CONNECT a.example:443 HTTP/1.1\r\n\r\n");
    await exchange(socketPath, "CONNECT b.example:443 HTTP/1.1\r\n\r\n");

    expect(logs.map((entry) => [entry.id, entry.target])).toEqual([
      [1, "a.example:443"],
      [2, "b.example:443"],
    ]);
  });

  it("destroys open tunnels when it closes", async () => {
    const upstream = await startTcpEcho();
    const target = `127.0.0.1:${upstream.port}`;
    const { socketPath, proxy } = await startProxy([target]);
    const client = await connected(connect(socketPath));
    client.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
    await readHead(client);
    client.resume();

    await proxy.close();

    await closed(client);
  });
});

describe("parseTarget", () => {
  it("lowercases the host and drops a trailing dot", () => {
    expect(parseTarget("API.Anthropic.com.:443")).toEqual({
      host: "api.anthropic.com",
      port: 443,
    });
  });

  it("accepts IPv4 and bracketed IPv6 hosts", () => {
    expect(parseTarget("127.0.0.1:8080")).toEqual({
      host: "127.0.0.1",
      port: 8080,
    });
    expect(parseTarget("[::1]:8080")).toEqual({ host: "::1", port: 8080 });
  });

  it.each([
    "example.com",
    "example.com:",
    "example.com:0",
    "example.com:65536",
    "example.com:443x",
    ":443",
    "exa mple.com:443",
    "-example.com:443",
    "example..com:443",
    "[example.com]:443",
    "::1:443",
    "user@example.com:443",
  ])("rejects %j", (value) => {
    expect(parseTarget(value)).toBeUndefined();
  });
});

describe("formatTarget", () => {
  it("brackets IPv6 hosts", () => {
    expect(formatTarget({ host: "::1", port: 443 })).toBe("[::1]:443");
    expect(formatTarget({ host: "example.com", port: 443 })).toBe(
      "example.com:443",
    );
  });
});

describe("parseAllowList", () => {
  it("normalizes every entry", () => {
    expect(parseAllowList(["API.anthropic.com:443"])).toEqual(
      new Set(["api.anthropic.com:443"]),
    );
  });

  it("names the entry it cannot parse", () => {
    expect(() => parseAllowList(["api.anthropic.com:443", "nope"])).toThrow(
      'invalid allow entry "nope"',
    );
  });
});

async function startProxy(allow: string[]) {
  const socketPath = join(await tempDir(), "proxy.sock");
  const logs: EgressLogEntry[] = [];
  const proxy = createEgressProxy({ allow, log: (entry) => logs.push(entry) });
  await listen(proxy.server, { path: socketPath });
  onCleanUp(() => proxy.close());
  return { socketPath, logs, proxy };
}

/** Sends one request on a fresh connection and returns the response head. */
async function exchange(socketPath: string, request: string): Promise<string> {
  const client: Socket = await connected(connect(socketPath));
  client.write(request);
  return readHead(client);
}

function statusLine(head: string): string {
  return head.split("\r\n")[0] ?? "";
}
