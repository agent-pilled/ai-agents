import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BrokerLogEntry, createBrokerStub } from "./broker-stub.ts";
import { cleanUp, listen, onCleanUp, tempDir } from "./test-support.ts";

afterEach(cleanUp);

describe("the broker stub", () => {
  it("serves its OpenAPI description on the Unix socket", async () => {
    const { socketPath, logs } = await startBroker();

    const response = await get(socketPath, "GET", "/openapi.json");

    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    const document = JSON.parse(response.body);
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(["/openapi.json"]);
    expect(logs).toEqual([
      {
        time: expect.any(String),
        method: "GET",
        path: "/openapi.json",
        status: 200,
      },
    ]);
  });

  it("answers 404 for any other path", async () => {
    const { socketPath } = await startBroker();

    const response = await get(socketPath, "GET", "/forge/changes");

    expect(response.status).toBe(404);
  });

  it("answers 405 for methods other than GET and HEAD", async () => {
    const { socketPath } = await startBroker();

    const response = await get(socketPath, "POST", "/openapi.json");

    expect(response.status).toBe(405);
    expect(response.allow).toBe("GET, HEAD");
  });

  it("leaves the query string out of its log", async () => {
    const { socketPath, logs } = await startBroker();

    await get(socketPath, "GET", "/openapi.json?token=abc");

    expect(logs.map((entry) => entry.path)).toEqual(["/openapi.json"]);
  });
});

async function startBroker() {
  const socketPath = join(await tempDir(), "broker.sock");
  const logs: BrokerLogEntry[] = [];
  const broker = createBrokerStub({ log: (entry) => logs.push(entry) });
  await listen(broker.server, { path: socketPath });
  onCleanUp(() => broker.close());
  return { socketPath, logs };
}

function get(
  socketPath: string,
  method: string,
  path: string,
): Promise<{
  status: number;
  contentType: string | undefined;
  allow: string | undefined;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"],
          allow: response.headers.allow,
          body,
        }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
