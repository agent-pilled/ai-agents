import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("the demo commands", () => {
  it("prints usage for node tools/demo/run.ts --help", async () => {
    const { stdout, stderr } = await run(
      process.execPath,
      ["tools/demo/run.ts", "--help"],
      { cwd: root },
    );

    expect(stderr).toBe("");
    expect(stdout).toMatch(/Usage: node tools\/demo\/run\.ts/);
    expect(stdout).toMatch(/FORGECREW_DEV_APP_ID/);
    expect(stdout).toMatch(/FORGECREW_REVIEW_KEY_FILE/);
    expect(stdout).toMatch(/FORGECREW_QA_APP_ID/);
    expect(stdout).toMatch(/--pause/);
    expect(stdout).toMatch(/GH_TOKEN/);
  });
});
