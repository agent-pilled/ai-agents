import { type ChildProcess, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanUp,
  connected,
  onCleanUp,
  readBytes,
  readHead,
  startTcpEcho,
  startUnixEcho,
  tempDir,
} from "./test-support.ts";

afterEach(cleanUp);

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));

describe("the spike CLI", () => {
  it("runs the egress proxy, logs JSON lines and stops on SIGTERM", async () => {
    const upstream = await startTcpEcho();
    const target = `127.0.0.1:${upstream.port}`;
    const socketPath = join(await tempDir(), "proxy.sock");
    const proxy = await start([
      "proxy",
      "--socket",
      socketPath,
      "--allow",
      target,
    ]);

    const client = await connected(connect(socketPath));
    client.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`);
    await readHead(client);
    client.write("ok");
    expect(await readBytes(client, 2)).toBe("ok");

    expect(await proxy.stop()).toBe(0);
    expect(proxy.lines[0]).toMatchObject({
      event: "listening",
      socket: socketPath,
      allow: [target],
    });
    expect(proxy.lines[1]).toMatchObject({
      event: "attempt",
      target,
      decision: "allow",
    });
  });

  it("runs the broker stub", async () => {
    const socketPath = join(await tempDir(), "broker.sock");
    const broker = await start(["broker", "--socket", socketPath]);

    const status = await new Promise<number | undefined>((resolve, reject) => {
      request({ socketPath, path: "/openapi.json" }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on("error", reject)
        .end();
    });

    expect(status).toBe(200);
    expect(await broker.stop()).toBe(0);
    expect(broker.lines[1]).toMatchObject({
      path: "/openapi.json",
      status: 200,
    });
  });

  it("runs the bridge on the given port", async () => {
    const socketPath = join(await tempDir(), "upstream.sock");
    await startUnixEcho(socketPath);
    const bridge = await start([
      "bridge",
      "--socket",
      socketPath,
      "--port",
      "0",
    ]);
    const port = Number(bridge.lines[0]?.port);

    const client = await connected(connect(port, "127.0.0.1"));
    client.write("hi");
    expect(await readBytes(client, 2)).toBe("hi");

    expect(await bridge.stop()).toBe(0);
    expect(bridge.lines[0]).toMatchObject({
      event: "listening",
      address: "127.0.0.1",
    });
  });

  it("rejects an invalid probe configuration with a message", async () => {
    const config = join(await tempDir(), "probe-config.json");
    await writeFile(config, JSON.stringify({ hostHome: "/home/operator" }));

    const { code, stderr } = await run(["probes", "--config", config]);

    expect(code).toBe(1);
    expect(stderr).toContain("probe config:");
  });

  it("rejects an unknown command with usage", async () => {
    const { code, stderr } = await run(["nope"]);

    expect(code).toBe(2);
    expect(stderr).toContain("usage:");
  });
});

interface Started {
  readonly lines: Array<Record<string, unknown>>;
  stop(): Promise<number | null>;
}

/** Starts a long-running command and waits for its first log line. */
async function start(args: string[]): Promise<Started> {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  onCleanUp(async () => {
    child.kill("SIGKILL");
  });
  const lines: Array<Record<string, unknown>> = [];
  const firstLine = new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`exited with ${code}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      lines.push(JSON.parse(line));
      resolve();
    });
  });
  await firstLine;
  return { lines, stop: () => stop(child) };
}

function stop(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.removeAllListeners("exit");
    child.once("close", (code) => resolve(code));
    child.kill("SIGTERM");
  });
}

function run(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("close", (code) => resolve({ code, stderr }));
  });
}
