import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BridgeLogEntry, createBridge } from "./bridge.ts";
import { createEgressProxy } from "./egress-proxy.ts";
import {
  cleanUp,
  closed,
  connected,
  eventually,
  listen,
  onCleanUp,
  portOf,
  readBytes,
  readHead,
  startTcpEcho,
  startUnixEcho,
  tempDir,
} from "./test-support.ts";

afterEach(cleanUp);

describe("the bridge", () => {
  it("forwards bytes both ways between a TCP client and the Unix socket", async () => {
    const socketPath = join(await tempDir(), "upstream.sock");
    await startUnixEcho(socketPath);
    const { port, logs } = await startBridge(socketPath);

    const client = await connected(connect(port, "127.0.0.1"));
    client.write("hello");
    expect(await readBytes(client, 5)).toBe("hello");
    client.end();
    await eventually(() => logs.some((entry) => entry.event === "closed"));

    expect(logs).toEqual([
      { time: expect.any(String), id: 1, event: "open" },
      {
        time: expect.any(String),
        id: 1,
        event: "closed",
        bytesUp: 5,
        bytesDown: 5,
      },
    ]);
  });

  it("closes the client and logs the error when the Unix socket is missing", async () => {
    const socketPath = join(await tempDir(), "missing.sock");
    const { port, logs } = await startBridge(socketPath);

    const client = await connected(connect(port, "127.0.0.1"));
    client.resume();
    await closed(client);
    await eventually(() => logs.some((entry) => entry.event === "error"));

    expect(logs).toContainEqual({
      time: expect.any(String),
      id: 1,
      event: "error",
      error: "ENOENT",
    });
  });

  it("carries a CONNECT tunnel through the egress proxy to an allowed upstream", async () => {
    const upstream = await startTcpEcho();
    const target = `127.0.0.1:${upstream.port}`;
    const proxySocket = join(await tempDir(), "proxy.sock");
    const proxy = createEgressProxy({ allow: [target], log: () => {} });
    await listen(proxy.server, { path: proxySocket });
    onCleanUp(() => proxy.close());
    const { port } = await startBridge(proxySocket);

    const client = await connected(connect(port, "127.0.0.1"));
    client.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
    expect((await readHead(client)).split("\r\n")[0]).toBe(
      "HTTP/1.1 200 Connection Established",
    );
    client.write("through");
    expect(await readBytes(client, 7)).toBe("through");
  });

  it("destroys open connections when it closes", async () => {
    const socketPath = join(await tempDir(), "upstream.sock");
    await startUnixEcho(socketPath);
    const { port, bridge } = await startBridge(socketPath);
    const client = await connected(connect(port, "127.0.0.1"));
    client.resume();

    await bridge.close();

    await closed(client);
  });
});

async function startBridge(socketPath: string) {
  const logs: BridgeLogEntry[] = [];
  const bridge = createBridge({ socketPath, log: (entry) => logs.push(entry) });
  await listen(bridge.server, { host: "127.0.0.1", port: 0 });
  onCleanUp(() => bridge.close());
  return { port: portOf(bridge.server), logs, bridge };
}
