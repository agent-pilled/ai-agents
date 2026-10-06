import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialsError,
  prepareOutputDirectory,
  saveCredentials,
} from "../../../tools/github-apps/credentials.ts";
import { Secret } from "../../../tools/github-apps/secret.ts";
import { FAKE_PRIVATE_KEY } from "./support/stub-github.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "forgecrew-credentials-"));
  roots.push(root);
  return root;
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

const app = {
  id: 424242,
  slug: "example-review-bot",
  privateKey: new Secret(FAKE_PRIVATE_KEY),
};

describe("saving the credentials", () => {
  it("writes the App ID and the private key to files named after the App", async () => {
    const dir = await tempDir();

    const saved = await saveCredentials(dir, app);

    expect(saved.appIdPath).toBe(join(dir, "example-review-bot-424242.app-id"));
    expect(saved.privateKeyPath).toBe(
      join(dir, "example-review-bot-424242.private-key.pem"),
    );
    expect(await readFile(saved.appIdPath, "utf8")).toBe("424242\n");
    expect(await readFile(saved.privateKeyPath, "utf8")).toBe(FAKE_PRIVATE_KEY);
  });

  it("names the files after the ID alone when GitHub's slug cannot be used", async () => {
    const dir = await tempDir();

    const saved = await saveCredentials(dir, { ...app, slug: undefined });

    expect(saved.appIdPath).toBe(join(dir, "app-424242.app-id"));
    expect(saved.privateKeyPath).toBe(join(dir, "app-424242.private-key.pem"));
    expect(await readFile(saved.privateKeyPath, "utf8")).toBe(FAKE_PRIVATE_KEY);
  });

  it("makes both files readable by their owner alone", async () => {
    const dir = await tempDir();

    const saved = await saveCredentials(dir, app);

    expect(await modeOf(saved.appIdPath)).toBe(0o600);
    expect(await modeOf(saved.privateKeyPath)).toBe(0o600);
  });

  it("keeps the files private whatever the umask says", async () => {
    const dir = await tempDir();
    const before = process.umask(0o000);
    let saved: Awaited<ReturnType<typeof saveCredentials>>;
    try {
      saved = await saveCredentials(dir, app);
    } finally {
      process.umask(before);
    }

    expect(await modeOf(saved.privateKeyPath)).toBe(0o600);
    expect(await modeOf(saved.appIdPath)).toBe(0o600);
  });

  it("ends the key with a newline", async () => {
    const dir = await tempDir();

    const saved = await saveCredentials(dir, {
      ...app,
      privateKey: new Secret(FAKE_PRIVATE_KEY.trimEnd()),
    });

    expect(await readFile(saved.privateKeyPath, "utf8")).toBe(FAKE_PRIVATE_KEY);
  });

  it("never overwrites an existing file, and does not quote the key when it refuses", async () => {
    const dir = await tempDir();
    const existing = join(dir, "example-review-bot-424242.private-key.pem");
    await writeFile(existing, "an older key\n", { mode: 0o600 });

    const failure = await saveCredentials(dir, app).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(CredentialsError);
    expect((failure as CredentialsError).message).toMatch(/already exists/);
    expect((failure as CredentialsError).message).not.toContain(
      FAKE_PRIVATE_KEY.split("\n")[1],
    );
    expect(await readFile(existing, "utf8")).toBe("an older key\n");
  });
});

describe("preparing the output directory", () => {
  it("creates a missing directory for the owner alone", async () => {
    const root = await tempDir();
    const dir = join(root, "nested", "keys");

    await prepareOutputDirectory(dir);

    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await modeOf(dir)).toBe(0o700);
  });

  it("accepts a directory that exists and leaves it alone", async () => {
    const dir = await tempDir();
    await chmod(dir, 0o750);

    await prepareOutputDirectory(dir);

    expect(await modeOf(dir)).toBe(0o750);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects a path that is a file", async () => {
    const root = await tempDir();
    const file = join(root, "a-file");
    await writeFile(file, "");

    await expect(prepareOutputDirectory(file)).rejects.toThrow(
      /not a directory/,
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "rejects a directory the operator cannot write to, before anything is consumed",
    async () => {
      const dir = await tempDir();
      await chmod(dir, 0o500);

      await expect(prepareOutputDirectory(dir)).rejects.toThrow(/Cannot write/);
    },
  );

  it.each([
    ["a directory", "dir"],
    ["a file, as a linked worktree has", "file"],
  ])(
    "rejects a place inside a Git work tree that has .git as %s",
    async (_what, kind) => {
      const root = await tempDir();
      if (kind === "dir") {
        await mkdir(join(root, ".git"));
      } else {
        await writeFile(join(root, ".git"), "gitdir: /elsewhere\n");
      }
      const dir = join(root, "deep", "keys");

      await expect(prepareOutputDirectory(dir)).rejects.toThrow(
        /Git work tree/,
      );
      // It refused before creating anything.
      await expect(stat(join(root, "deep"))).rejects.toThrow();
    },
  );
});
