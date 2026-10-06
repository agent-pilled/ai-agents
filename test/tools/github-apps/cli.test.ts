import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../../tools/github-apps/cli.ts";
import {
  FAKE_PRIVATE_KEY,
  FAKE_SECRETS,
  fakeConversionBody,
  type StubGithub,
  startStubGithub,
} from "./support/stub-github.ts";

const run = promisify(execFile);
const entry = fileURLToPath(
  new URL("../../../tools/github-apps/register.ts", import.meta.url),
);

// A fake code that no output may contain, whatever it prints.
const CODE = "code-4f9c2a7e1b83d605";

let stub: StubGithub;
const dirs: string[] = [];

beforeEach(async () => {
  stub = await startStubGithub();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stub.close();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forgecrew-cli-"));
  dirs.push(dir);
  return dir;
}

interface Captured {
  stdout: string;
  stderr: string;
}

// Everything that reaches a process stream or the console while a command
// runs, as well as what the command itself writes.
function capture() {
  const captured: Captured = { stdout: "", stderr: "" };
  const ambient: string[] = [];
  const record = (...args: unknown[]) => {
    ambient.push(args.map(String).join(" "));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(record);
  vi.spyOn(process.stderr, "write").mockImplementation(record);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(record);
  }
  const io = {
    stdout: {
      write: (text: string) => {
        captured.stdout += text;
      },
    },
    stderr: {
      write: (text: string) => {
        captured.stderr += text;
      },
    },
  };
  return { io, captured, ambient };
}

function expectNoSecrets(...outputs: string[]): void {
  for (const output of outputs) {
    for (const secret of FAKE_SECRETS) expect(output).not.toContain(secret);
    expect(output).not.toContain(CODE);
    expect(output).not.toContain("BEGIN RSA PRIVATE KEY");
  }
}

function decode(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

// Plays the browser against the page the command announces.
async function clickThrough(captured: Captured, code = CODE): Promise<string> {
  const pageUrl = await vi.waitFor(() => {
    const match = /http:\/\/127\.0\.0\.1:\d+\//.exec(captured.stdout);
    if (!match) throw new Error("the command has not announced its page yet");
    return match[0];
  });
  const html = await (await fetch(pageUrl)).text();
  const action = decode(
    /<form method="post" action="([^"]*)">/.exec(html)?.[1] ?? "",
  );
  const manifest = JSON.parse(
    decode(/name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? ""),
  ) as { redirect_url: string };
  await fetch(action, {
    method: "POST",
    body: new URLSearchParams({ manifest: JSON.stringify(manifest) }),
  });
  const redirect = new URL(manifest.redirect_url);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set(
    "state",
    new URL(action).searchParams.get("state") ?? "",
  );
  await fetch(redirect);
  return pageUrl;
}

function deps() {
  return {
    endpoints: { webBaseUrl: stub.url, apiBaseUrl: stub.url },
    timeoutMs: 5_000,
  };
}

describe("the register command", () => {
  it("registers an App end to end and prints what the operator does next", async () => {
    const out = await tempDir();
    const { io, captured, ambient } = capture();

    const exit = main(
      ["--app", "review-bot", "--name", "Example Review Bot", "--out", out],
      io,
      deps(),
    );
    await clickThrough(captured);

    expect(await exit).toBe(0);
    expect(captured.stderr).toBe("");
    expect(captured.stdout).toMatch(/waits up to one hour/);
    expect(captured.stdout).toContain("Example Review Bot");
    expect(captured.stdout).toContain("424242");
    expect(captured.stdout).toContain(
      join(out, "example-review-bot-424242.private-key.pem"),
    );
    expect(captured.stdout).toContain(
      join(out, "example-review-bot-424242.app-id"),
    );
    expect(captured.stdout).toMatch(
      /Move the private key into the role's keychain account, then delete the file/,
    );
    expect(captured.stdout).toContain(
      `${stub.url}/apps/example-review-bot/installations/new`,
    );
    expect(await readdir(out)).toHaveLength(2);
    const key = join(out, "example-review-bot-424242.private-key.pem");
    expect(await readFile(key, "utf8")).toBe(FAKE_PRIVATE_KEY);
    expect((await stat(key)).mode & 0o777).toBe(0o600);
    expect(ambient).toEqual([]);
  });

  it("never prints the key, the client secret, the webhook secret or the code", async () => {
    const out = await tempDir();
    const { io, captured, ambient } = capture();

    const exit = main(
      [
        "--app",
        "scheduler",
        "--name",
        "Example Scheduler",
        "--out",
        out,
        "--org",
        "example-org",
      ],
      io,
      deps(),
    );
    await clickThrough(captured);
    await exit;

    expectNoSecrets(captured.stdout, captured.stderr, ambient.join("\n"));
    expect(captured.stdout).toContain("example-org");
  });

  it("does not print the state either", async () => {
    const out = await tempDir();
    const { io, captured } = capture();

    const exit = main(
      ["--app", "review-bot", "--name", "Example Review Bot", "--out", out],
      io,
      deps(),
    );
    await clickThrough(captured);
    await exit;

    const state = new URL(
      stub.requests.find((r) => r.path.includes("state="))?.path ?? "/",
      stub.url,
    ).searchParams.get("state");
    expect(state).toBeTruthy();
    expect(captured.stdout).not.toContain(state as string);
  });

  it("still saves the key when GitHub's slug is unusable, and points to the list of Apps", async () => {
    const github = await startStubGithub({
      conversion: () => ({
        status: 201,
        body: { ...fakeConversionBody(), slug: "my_bot.v2" },
      }),
    });
    const out = await tempDir();
    const { io, captured, ambient } = capture();

    const exit = main(
      ["--app", "review-bot", "--name", "Example Review Bot", "--out", out],
      io,
      {
        endpoints: { webBaseUrl: github.url, apiBaseUrl: github.url },
        timeoutMs: 5_000,
      },
    );
    await clickThrough(captured);

    expect(await exit).toBe(0);
    expect(await readdir(out)).toEqual([
      "app-424242.app-id",
      "app-424242.private-key.pem",
    ]);
    expect(captured.stdout).toContain("list of GitHub Apps");
    expect(captured.stdout).toContain(`${github.url}/settings/apps`);
    expectNoSecrets(captured.stdout, captured.stderr, ambient.join("\n"));
    await github.close();
  });

  it("exits 1 with GitHub's reason when the conversion is refused, and keeps the body out", async () => {
    const github = await startStubGithub({
      conversion: () => ({
        status: 404,
        body: { message: "Not Found", echoed: FAKE_SECRETS[2] },
      }),
    });
    const out = await tempDir();
    const { io, captured, ambient } = capture();

    const exit = main(
      ["--app", "review-bot", "--name", "Example Review Bot", "--out", out],
      io,
      {
        endpoints: { webBaseUrl: github.url, apiBaseUrl: github.url },
        timeoutMs: 5_000,
      },
    );
    await clickThrough(captured);

    expect(await exit).toBe(1);
    expect(captured.stderr).toMatch(/404.*Not Found/s);
    expect(captured.stderr).toMatch(/already created the App/);
    expectNoSecrets(captured.stdout, captured.stderr, ambient.join("\n"));
    expect(await readdir(out)).toEqual([]);
    await github.close();
  });

  it("exits 1 before starting when the output directory is inside a Git work tree", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".git"));
    const { io, captured } = capture();

    const exit = await main(
      [
        "--app",
        "review-bot",
        "--name",
        "Example Review Bot",
        "--out",
        join(root, "keys"),
      ],
      io,
      deps(),
    );

    expect(exit).toBe(1);
    expect(captured.stderr).toMatch(/Git work tree/);
    expect(captured.stdout).toBe("");
  });

  it("prints the usage and exits 0 for --help", async () => {
    const { io, captured } = capture();

    const exit = await main(["--help"], io, deps());

    expect(exit).toBe(0);
    expect(captured.stdout).toMatch(
      /Usage: node tools\/github-apps\/register\.ts/,
    );
    expect(captured.stdout).toMatch(/review-bot or scheduler/);
    expect(captured.stderr).toBe("");
  });

  it.each([
    [
      "a missing --out",
      ["--app", "review-bot", "--name", "Example Review Bot"],
      /--out is required/,
    ],
    [
      "an unknown App",
      ["--app", "dev-bot", "--name", "x", "--out", "/tmp/x"],
      /review-bot, scheduler/,
    ],
    [
      "an invalid App name",
      ["--app", "review-bot", "--name", "bad<name>", "--out", "/tmp/x"],
      /--name may contain only/,
    ],
    [
      "an invalid organization",
      [
        "--app",
        "review-bot",
        "--name",
        "x",
        "--out",
        "/tmp/x",
        "--org",
        "../up",
      ],
      /not a valid GitHub login/,
    ],
    ["an unknown flag", ["--app", "review-bot", "--bogus"], /bogus/],
    ["a flag without a value", ["--app", "review-bot", "--name"], /name/],
    ["a stray argument", ["review-bot"], /review-bot/],
  ])(
    "exits 2 with a message for %s, and starts nothing",
    async (_why, argv, message) => {
      const { io, captured } = capture();

      const exit = await main(argv, io, deps());

      expect(exit).toBe(2);
      expect(captured.stderr).toMatch(message);
      expect(captured.stderr).toMatch(/Usage:/);
      expect(captured.stdout).toBe("");
      expect(stub.requests).toEqual([]);
    },
  );
});

describe("the entry script", () => {
  it("runs under Node as TypeScript source, without warnings", async () => {
    const { stdout, stderr } = await run(process.execPath, [entry, "--help"]);

    expect(stdout).toMatch(/Usage: node tools\/github-apps\/register\.ts/);
    expect(stderr).toBe("");
  });

  it("exits 2 for a usage error", async () => {
    const failure = await run(process.execPath, [entry]).catch(
      (error: unknown) => error as { code: number; stderr: string },
    );

    expect(failure).toMatchObject({ code: 2 });
    expect((failure as { stderr: string }).stderr).toMatch(/--app is required/);
  });
});
