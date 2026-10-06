// The egress proxy runs outside the sandbox. It listens on a Unix socket that
// is mounted into the sandbox, accepts HTTP CONNECT to the configured
// host:port pairs only, and logs every attempt, allowed or denied.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIPv4, isIPv6, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export interface EgressProxyOptions {
  /** host:port pairs the proxy may tunnel to, such as "api.anthropic.com:443". */
  readonly allow: readonly string[];
  /** Receives one entry per attempt and one per upstream error or closed tunnel. */
  readonly log: (entry: EgressLogEntry) => void;
  /** How long to wait for an upstream connection. */
  readonly connectTimeoutMs?: number;
}

export type EgressLogEntry =
  | AttemptEntry
  | {
      readonly time: string;
      readonly id: number;
      readonly event: "upstream-error";
      readonly target: string;
      readonly error: string;
    }
  | {
      readonly time: string;
      readonly id: number;
      readonly event: "closed";
      readonly target: string;
      readonly bytesUp: number;
      readonly bytesDown: number;
      readonly durationMs: number;
    };

type AttemptEntry = {
  readonly time: string;
  readonly id: number;
  readonly event: "attempt";
  /** null when the request has no parsable method. */
  readonly method: string | null;
  /** host:port, never a path or query, so the log cannot capture secrets in URLs. */
  readonly target: string | null;
} & (
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: DenyReason }
);

export type DenyReason =
  | "not-allowed"
  | "method-not-allowed"
  | "bad-target"
  | "bad-request";

export interface EgressProxy {
  readonly server: Server;
  /** Stops accepting connections and destroys open tunnels. */
  close(): Promise<void>;
}

export interface Target {
  readonly host: string;
  readonly port: number;
}

export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
  const allowed = parseAllowList(options.allow);
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const open = new Set<Duplex>();
  let lastId = 0;

  const server = createServer();
  server.on("connect", (request: IncomingMessage, client: Duplex, head) => {
    const id = ++lastId;
    track(open, client);
    client.on("error", () => client.destroy());

    const target = parseTarget(request.url ?? "");
    if (target === undefined) {
      deny(id, "CONNECT", null, "bad-target");
      refuse(client, 400, "Bad Request", "expected CONNECT host:port");
      return;
    }
    const name = formatTarget(target);
    if (!allowed.has(name)) {
      deny(id, "CONNECT", name, "not-allowed");
      refuse(client, 403, "Forbidden", `${name} is not allowed`);
      return;
    }

    options.log({
      time: now(),
      id,
      event: "attempt",
      method: "CONNECT",
      target: name,
      decision: "allow",
    });
    tunnel(id, name, target, client, head);
  });

  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const id = ++lastId;
    deny(
      id,
      request.method ?? "",
      absoluteTarget(request.url),
      "method-not-allowed",
    );
    response.writeHead(405, {
      allow: "CONNECT",
      connection: "close",
      "content-type": "text/plain",
    });
    response.end("forgecrew egress proxy: only CONNECT is allowed\n");
  });

  server.on("clientError", (error: NodeJS.ErrnoException, client: Duplex) => {
    if (error.code === "ECONNRESET" || !client.writable) {
      client.destroy();
      return;
    }
    deny(++lastId, null, null, "bad-request");
    refuse(client, 400, "Bad Request", "cannot parse the request");
  });

  function tunnel(
    id: number,
    name: string,
    target: Target,
    client: Duplex,
    head: Buffer,
  ): void {
    const started = Date.now();
    let established = false;
    let finished = false;
    const upstream: Socket = connect({ host: target.host, port: target.port });
    track(open, upstream);
    upstream.setTimeout(connectTimeoutMs);

    upstream.once("connect", () => {
      established = true;
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once("timeout", () => upstream.destroy(timeoutError()));
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (established || finished) {
        return;
      }
      finished = true;
      options.log({
        time: now(),
        id,
        event: "upstream-error",
        target: name,
        error: error.code ?? error.message,
      });
      const timedOut = error.code === "ETIMEDOUT";
      refuse(
        client,
        timedOut ? 504 : 502,
        timedOut ? "Gateway Timeout" : "Bad Gateway",
        `cannot reach ${name}`,
      );
    });

    const finish = () => {
      client.destroy();
      upstream.destroy();
      if (finished) {
        return;
      }
      finished = true;
      options.log({
        time: now(),
        id,
        event: "closed",
        target: name,
        bytesUp: upstream.bytesWritten,
        bytesDown: upstream.bytesRead,
        durationMs: Date.now() - started,
      });
    };
    upstream.once("close", () => {
      if (established) {
        finish();
      }
    });
    client.once("close", finish);
  }

  function deny(
    id: number,
    method: string | null,
    target: string | null,
    reason: DenyReason,
  ): void {
    options.log({
      time: now(),
      id,
      event: "attempt",
      method,
      target,
      decision: "deny",
      reason,
    });
  }

  return {
    server,
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) {
          socket.destroy();
        }
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Parses "host:port" or "[ipv6]:port", lowercasing the host and dropping a trailing dot. */
export function parseTarget(value: string): Target | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, bracketed, plain, portText] = match;
  const port = Number(portText);
  if (port < 1 || port > 65_535) {
    return undefined;
  }
  if (bracketed !== undefined) {
    return isIPv6(bracketed)
      ? { host: bracketed.toLowerCase(), port }
      : undefined;
  }
  const host = (plain ?? "").toLowerCase().replace(/\.$/, "");
  return isIPv4(host) || isHostName(host) ? { host, port } : undefined;
}

export function formatTarget(target: Target): string {
  return isIPv6(target.host)
    ? `[${target.host}]:${target.port}`
    : `${target.host}:${target.port}`;
}

/** Normalizes allowlist entries; throws on the first entry it cannot parse. */
export function parseAllowList(entries: readonly string[]): Set<string> {
  return new Set(
    entries.map((entry) => {
      const target = parseTarget(entry);
      if (target === undefined) {
        throw new Error(`invalid allow entry ${JSON.stringify(entry)}`);
      }
      return formatTarget(target);
    }),
  );
}

function isHostName(host: string): boolean {
  return host
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** The host:port of an absolute-form request URL, or null. */
function absoluteTarget(url: string | undefined): string | null {
  if (url === undefined || !URL.canParse(url)) {
    return null;
  }
  const parsed = new URL(url);
  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  const target = parseTarget(
    `${parsed.hostname}:${parsed.port || defaultPort}`,
  );
  return target === undefined ? null : formatTarget(target);
}

function refuse(
  client: Duplex,
  status: number,
  reason: string,
  body: string,
): void {
  client.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "content-type: text/plain\r\n" +
      "connection: close\r\n\r\n" +
      `forgecrew egress proxy: ${body}\n`,
  );
}

function track(open: Set<Duplex>, socket: Duplex): void {
  open.add(socket);
  socket.once("close", () => open.delete(socket));
}

function timeoutError(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("upstream connect timed out");
  error.code = "ETIMEDOUT";
  return error;
}

function now(): string {
  return new Date().toISOString();
}
