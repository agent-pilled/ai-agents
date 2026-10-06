// A stand-in for the per-pass broker (docs/design.md, "Broker"). It listens on
// a second Unix socket mounted into the sandbox and serves only its OpenAPI
// description, so the spike can show that the broker is reachable from inside
// while the network is not.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface BrokerStubOptions {
  readonly log: (entry: BrokerLogEntry) => void;
}

export interface BrokerLogEntry {
  readonly time: string;
  readonly method: string;
  /** The request path without its query string. */
  readonly path: string;
  readonly status: number;
}

export interface BrokerStub {
  readonly server: Server;
  /** Stops accepting connections and closes open ones. */
  close(): Promise<void>;
}

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Forgecrew broker (spike stub)",
    version: "0.0.0",
    description:
      "Serves only this description. The real broker offers forge reads, the keychain and result submission.",
  },
  paths: {
    "/openapi.json": {
      get: {
        summary: "This description",
        responses: { "200": { description: "The OpenAPI document" } },
      },
    },
  },
} as const;

export function createBrokerStub(options: BrokerStubOptions): BrokerStub {
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const method = request.method ?? "";
      const path = (request.url ?? "").split("?")[0] ?? "";
      const status = route(method, path, response);
      options.log({ time: new Date().toISOString(), method, path, status });
    },
  );

  return {
    server,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function route(method: string, path: string, response: ServerResponse): number {
  if (path !== "/openapi.json") {
    return send(response, 404, { error: "not found" });
  }
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    return send(response, 405, { error: "method not allowed" });
  }
  return send(response, 200, openApiDocument);
}

function send(response: ServerResponse, status: number, body: unknown): number {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
  return status;
}
