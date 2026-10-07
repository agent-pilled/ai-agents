// The command line for the spike's Node components. run.sh starts the proxy
// and the broker outside the sandbox; sandbox-entry.sh starts the bridge and
// the probes inside it. Every component logs JSON lines to stdout and stops
// on SIGTERM or SIGINT.
import { readFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import type { Server as NetServer } from "node:net";
import { parseArgs } from "node:util";
import { createBridge } from "./bridge.ts";
import { createBrokerStub } from "./broker-stub.ts";
import { createEgressProxy } from "./egress-proxy.ts";
import { parseProbeConfig, runProbes } from "./probes.ts";
import { summarize } from "./summarize.ts";

const usage = `usage:
  node cli.ts proxy  --socket PATH --allow HOST:PORT [--allow HOST:PORT ...]
  node cli.ts broker --socket PATH
  node cli.ts bridge --socket PATH --port PORT
  node cli.ts probes --config PATH
  node cli.ts summarize RUN_DIR`;

class UsageError extends Error {}

await main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (error instanceof UsageError) {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
  process.exit(1);
});

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case "proxy": {
      const { socket, allow } = options(args, { socket: true, allow: true });
      const proxy = createEgressProxy({ allow, log: writeLine });
      await listen(proxy.server, { path: socket });
      writeLine({ time: now(), event: "listening", socket, allow });
      stopOnSignal(proxy.close);
      return;
    }
    case "broker": {
      const { socket } = options(args, { socket: true });
      const broker = createBrokerStub({ log: writeLine });
      await listen(broker.server, { path: socket });
      writeLine({ time: now(), event: "listening", socket });
      stopOnSignal(broker.close);
      return;
    }
    case "bridge": {
      const { socket, port } = options(args, { socket: true, port: true });
      const bridge = createBridge({ socketPath: socket, log: writeLine });
      await listen(bridge.server, { host: "127.0.0.1", port: Number(port) });
      const address = bridge.server.address();
      writeLine({
        time: now(),
        event: "listening",
        address: "127.0.0.1",
        port:
          typeof address === "object" && address !== null ? address.port : port,
        socket,
      });
      stopOnSignal(bridge.close);
      return;
    }
    case "probes": {
      const { config } = options(args, { config: true });
      await runProbes(
        parseProbeConfig(await readFile(config, "utf8")),
        writeLine,
      );
      return;
    }
    case "summarize": {
      const [runDir] = args;
      if (runDir === undefined || args.length !== 1) {
        throw new UsageError("summarize needs RUN_DIR");
      }
      process.stdout.write(await summarize(runDir));
      return;
    }
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command ?? "")}`);
  }
}

/** Parses the named string options, all required; only --allow repeats. */
function options<const Names extends Record<string, true>>(
  args: string[],
  names: Names,
): { [Name in keyof Names]: Name extends "allow" ? string[] : string } {
  const spec = Object.fromEntries(
    Object.keys(names).map((name) => [
      name,
      { type: "string" as const, multiple: name === "allow" },
    ]),
  );
  let values: Record<string, string | string[] | undefined>;
  try {
    values = parseArgs({ args, options: spec, strict: true }).values as Record<
      string,
      string | string[] | undefined
    >;
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  for (const name of Object.keys(names)) {
    const value = values[name];
    if (value === undefined || value.length === 0) {
      throw new UsageError(`missing --${name}`);
    }
  }
  return values as {
    [Name in keyof Names]: Name extends "allow" ? string[] : string;
  };
}

function listen(
  server: HttpServer | NetServer,
  options: { path: string } | { host: string; port: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function stopOnSignal(close: () => Promise<void>): void {
  const stop = () => {
    close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

function writeLine(entry: object): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function now(): string {
  return new Date().toISOString();
}
