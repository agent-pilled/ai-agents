// The bridge runs inside the sandbox, whose network namespace has only a
// loopback interface. It listens on 127.0.0.1 and forwards each connection to
// the egress proxy's Unix socket mounted into the sandbox, so the harness can
// use HTTPS_PROXY=http://127.0.0.1:<port>. It forwards bytes and decides
// nothing; the proxy outside makes every decision.
import { connect, createServer, type Server, type Socket } from "node:net";

export interface BridgeOptions {
  /** The egress proxy's socket as mounted inside the sandbox. */
  readonly socketPath: string;
  readonly log: (entry: BridgeLogEntry) => void;
}

export type BridgeLogEntry =
  | { readonly time: string; readonly id: number; readonly event: "open" }
  | {
      readonly time: string;
      readonly id: number;
      readonly event: "closed";
      readonly bytesUp: number;
      readonly bytesDown: number;
    }
  | {
      readonly time: string;
      readonly id: number;
      readonly event: "error";
      readonly error: string;
    };

export interface Bridge {
  readonly server: Server;
  /** Stops accepting connections and destroys open ones. */
  close(): Promise<void>;
}

export function createBridge(options: BridgeOptions): Bridge {
  const open = new Set<Socket>();
  let lastId = 0;

  const server = createServer((client) => {
    const id = ++lastId;
    options.log({ time: now(), id, event: "open" });
    const upstream = connect(options.socketPath);
    track(open, client);
    track(open, upstream);

    // One entry per connection: the first error, or the close with byte counts.
    let logged = false;
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (!logged) {
        logged = true;
        options.log({
          time: now(),
          id,
          event: "error",
          error: error.code ?? error.message,
        });
      }
    });
    client.on("error", () => client.destroy());

    const finish = () => {
      client.destroy();
      upstream.destroy();
      if (!logged) {
        logged = true;
        options.log({
          time: now(),
          id,
          event: "closed",
          bytesUp: upstream.bytesWritten,
          bytesDown: upstream.bytesRead,
        });
      }
    };
    client.once("close", finish);
    upstream.once("close", finish);

    client.pipe(upstream);
    upstream.pipe(client);
  });

  return {
    server,
    close: () =>
      new Promise((resolve) => {
        for (const socket of open) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

function track(open: Set<Socket>, socket: Socket): void {
  open.add(socket);
  socket.once("close", () => open.delete(socket));
}

function now(): string {
  return new Date().toISOString();
}
