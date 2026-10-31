import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GitHubForge } from "../../src/adapters/forge/github/github-forge.ts";
import { parseRepository, UsageError } from "./ruleset.ts";
import { runScenario } from "./scenario.ts";
import { githubDemoSide } from "./side.ts";

/**
 * Runs the scripted demo against a real repository. The three Apps come from
 * the environment. GH_TOKEN files the issue and is not given to an App.
 */

const LANES = ["review", "qa"] as const;

export interface CommandIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

export const USAGE = `Usage: node tools/demo/run.ts --repo <owner/name> [options]

Runs the scripted three-identity demo. dev-bot opens a pull request, GitHub
refuses its merge until review-bot and qa-bot have accepted that exact head,
and the closing "Fixes #n" closes the issue. No model writes or reviews code.

The ruleset must already be active. This command does not create Apps, tokens
or rulesets.

Required environment, one pair per identity:
  FORGECREW_DEV_APP_ID        FORGECREW_DEV_KEY_FILE
  FORGECREW_REVIEW_APP_ID     FORGECREW_REVIEW_KEY_FILE
  FORGECREW_QA_APP_ID         FORGECREW_QA_KEY_FILE
  GH_TOKEN                    files the issue, and nothing else

Options:
  --repo <owner/name>   the demo repository
  --pause <ms>          wait between steps, for a recording (default: 0)
  --help                show this text
`;

/** Exit 0 when the scenario finished, 2 for a usage error, 1 when a step surprised us. */
export async function main(
  argv: readonly string[],
  io: CommandIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let values: { repo?: string; pause?: string; help?: boolean };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        repo: { type: "string" },
        pause: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    io.stderr.write(`${message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help === true) {
    io.stdout.write(USAGE);
    return 0;
  }

  try {
    const repository = parseRepository(values.repo);
    const pause = parsePause(values.pause);
    const token = env.GH_TOKEN;
    if (token === undefined || token === "") {
      throw new UsageError("GH_TOKEN is required to file the issue.");
    }
    const dev = await credentials("DEV", env);
    const review = await credentials("REVIEW", env);
    const qa = await credentials("QA", env);
    const forge = (identity: { appId: string; privateKey: string }) =>
      new GitHubForge({
        appId: Number(identity.appId),
        privateKey: identity.privateKey,
        lanes: LANES,
      });
    const log = async (line: string) => {
      io.stdout.write(`${line}\n`);
      if (pause > 0) {
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    };
    const result = await runScenario(
      { dev: forge(dev), review: forge(review), qa: forge(qa) },
      githubDemoSide({
        repository,
        operatorToken: token,
        dev,
        qa,
      }),
      log,
    );
    io.stdout.write(
      `\nhttps://github.com/${repository}/pull/${result.pullNumber}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : "unknown error";
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

async function credentials(
  role: "DEV" | "REVIEW" | "QA",
  env: NodeJS.ProcessEnv,
): Promise<{ appId: string; privateKey: string }> {
  const idName = `FORGECREW_${role}_APP_ID`;
  const keyName = `FORGECREW_${role}_KEY_FILE`;
  const appId = env[idName];
  const keyFile = env[keyName];
  if (appId === undefined || appId === "") {
    throw new UsageError(`${idName} is required.`);
  }
  if (!/^[1-9][0-9]*$/.test(appId)) {
    throw new UsageError(`${idName} must be a positive integer.`);
  }
  if (keyFile === undefined || keyFile === "") {
    throw new UsageError(`${keyName} is required.`);
  }
  try {
    return { appId, privateKey: await readFile(keyFile, "utf8") };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      throw new UsageError(`${keyName} does not exist: ${keyFile}`);
    }
    throw error;
  }
}

function parsePause(value: string | undefined): number {
  if (value === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new UsageError("--pause must be a number of milliseconds.");
  }
  const pause = Number(value);
  if (pause > 60_000) throw new UsageError("--pause must be at most 60000.");
  return pause;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
