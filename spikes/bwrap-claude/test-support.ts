// Helpers shared by the spike's tests: temporary directories, echo servers
// and raw socket reads, all over real TCP and Unix sockets.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanups: Array<() => Promise<void>> = [];

/** Runs every registered cleanup, newest first. Call it from afterEach. */
export async function cleanUp(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
}

/** Registers a cleanup for the next cleanUp() call. */
export function onCleanUp(cleanup: () => Promise<void>): void {
  cleanups.push(cleanup);
}

/** A fresh directory with a short path, so Unix socket paths stay short. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fc-"));
  onCleanUp(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export interface EchoServer {
  /** How many connections the server has accepted. */
  connections(): number;
}

/** A TCP echo server on 127.0.0.1 and a free port. */
export async function startTcpEcho(): Promise<EchoServer & { port: number }> {
  const echo = echoServer();
  await listen(echo.server, { host: "127.0.0.1", port: 0 });
  return { connections: echo.connections, port: portOf(echo.server) };
}

/** A Unix socket echo server at the given path. */
export async function startUnixEcho(path: string): Promise<EchoServer> {
  const echo = echoServer();
  await listen(echo.server, { path });
  return { connections: echo.connections };
}

/** A TCP port on 127.0.0.1 that nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await listen(server, { host: "127.0.0.1", port: 0 });
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function listen(
  server: Server,
  options: { path: string } | { host: string; port: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP server");
  }
  return address.port;
}

/** Resolves once the socket is connected, and destroys it on cleanup. */
export async function connected(socket: Socket): Promise<Socket> {
  onCleanUp(async () => {
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      // Tests observe failures through closed(); a reset must not crash them.
      socket.on("error", () => {});
      resolve();
    });
  });
  return socket;
}

/** Reads until the end of an HTTP response head and returns the head. */
export function readHead(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const onData = (chunk: Buffer) => {
      received += chunk.toString("latin1");
      const end = received.indexOf("\r\n\r\n");
      if (end !== -1) {
        socket.off("data", onData);
        socket.off("error", reject);
        socket.pause();
        const rest = received.slice(end + 4);
        if (rest.length > 0) {
          socket.unshift(Buffer.from(rest, "latin1"));
        }
        resolve(received.slice(0, end));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

/** Reads until the socket has delivered at least `length` bytes. */
export function readBytes(socket: Socket, length: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= length) {
        socket.off("data", onData);
        socket.off("error", reject);
        resolve(received.toString("utf8"));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.resume();
  });
}

/** Resolves when the socket has closed. */
export function closed(socket: Socket): Promise<void> {
  if (socket.closed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

/** Polls until the predicate holds, or fails after the timeout. */
export async function eventually(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function echoServer(): EchoServer & { server: Server } {
  let accepted = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.pipe(socket);
  });
  onCleanUp(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  return { server, connections: () => accepted };
}
