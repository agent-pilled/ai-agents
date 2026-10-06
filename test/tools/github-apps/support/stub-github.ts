import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for github.com and api.github.com, so that no test calls the real
// forge. It answers the one API call the manifest flow needs and records every
// request, and it plays the part of GitHub's registration page by accepting the
// operator's form post.

// Obviously fake values. Tests assert that none of them ever reach an output.
export const FAKE_PRIVATE_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nFAKE-KEY-MATERIAL-NOT-A-REAL-KEY\n-----END RSA PRIVATE KEY-----\n";
export const FAKE_CLIENT_SECRET = "fake-client-secret-0123456789";
export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-0123456789";
export const FAKE_SECRETS = [
  FAKE_PRIVATE_KEY.split("\n")[1] as string,
  FAKE_CLIENT_SECRET,
  FAKE_WEBHOOK_SECRET,
] as const;

export const FAKE_APP = {
  id: 424242,
  slug: "example-review-bot",
  name: "Example Review Bot",
};

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface ConversionAnswer {
  readonly status: number;
  /** Sent as JSON unless it is a string, which is sent as it is. */
  readonly body: unknown;
  /** How long to wait before answering. */
  readonly delayMs?: number;
}

export interface StubGithub {
  /** Both the web and the API base URL. */
  readonly url: string;
  readonly requests: readonly StubRequest[];
  close(): Promise<void>;
}

export interface StubOptions {
  /** Defaults to GitHub's behaviour: a code converts once, then is unknown. */
  /**
   * "hang" never answers; "drop" closes the connection without an answer, as a
   * network failure would.
   */
  readonly conversion?: (
    code: string,
  ) => ConversionAnswer | "hang" | "drop" | Promise<ConversionAnswer | "drop">;
}

export function fakeConversionBody(): Record<string, unknown> {
  return {
    ...FAKE_APP,
    node_id: "FAKE_NODE_ID",
    client_id: "Iv1.fakeclientid",
    client_secret: FAKE_CLIENT_SECRET,
    webhook_secret: FAKE_WEBHOOK_SECRET,
    pem: FAKE_PRIVATE_KEY,
    html_url: `https://github.example/apps/${FAKE_APP.slug}`,
  };
}

export async function startStubGithub(
  options: StubOptions = {},
): Promise<StubGithub> {
  const requests: StubRequest[] = [];
  const usedCodes = new Set<string>();
  const conversion =
    options.conversion ??
    ((code: string): ConversionAnswer => {
      if (usedCodes.has(code)) {
        return { status: 404, body: { message: "Not Found" } };
      }
      usedCodes.add(code);
      return { status: 201, body: fakeConversionBody() };
    });
  const hanging: ServerResponse[] = [];

  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const path = request.url ?? "/";
      requests.push({
        method: request.method ?? "GET",
        path,
        headers: request.headers,
        body,
      });

      const match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
      if (request.method === "POST" && match) {
        const code = decodeURIComponent(match[1] as string);
        void Promise.resolve(conversion(code)).then((answer) => {
          if (answer === "hang") {
            hanging.push(response);
            return;
          }
          if (answer === "drop") {
            response.destroy();
            return;
          }
          setTimeout(() => respond(response, answer), answer.delayMs ?? 0);
        });
        return;
      }
      if (
        request.method === "POST" &&
        /^\/(organizations\/[^/]+\/)?settings\/apps\/new(\?|$)/.test(path)
      ) {
        respond(response, { status: 200, body: "registration page" });
        return;
      }
      respond(response, { status: 404, body: { message: "Not Found" } });
    });
  });

  await listen(server);
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const response of hanging) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function respond(response: ServerResponse, answer: ConversionAnswer): void {
  const text =
    typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
  response.writeHead(answer.status, {
    "content-type":
      typeof answer.body === "string" ? "text/plain" : "application/json",
  });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}
