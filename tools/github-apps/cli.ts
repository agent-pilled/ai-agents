import { parseArgs } from "node:util";
import { APP_KINDS } from "./manifests.ts";
import {
  ParameterError,
  parseParameters,
  type RegistrationParameters,
} from "./parameters.ts";
import {
  type RegistrationDeps,
  RegistrationError,
  type RegistrationResult,
  startRegistration,
} from "./registration.ts";

export interface Output {
  write(text: string): unknown;
}

export interface CommandIo {
  readonly stdout: Output;
  readonly stderr: Output;
}

export const USAGE = `Usage: node tools/github-apps/register.ts --app <app> --name <name> --out <directory> [options]

Registers a GitHub App from its manifest. The helper serves one page on this
machine. You open it, click through GitHub, and the helper saves the App ID
and the private key, readable by you only. It never prints the key.

Required:
  --app <app>         ${APP_KINDS.join(" or ")}
  --name <name>       the App's name on GitHub, at most 34 characters
  --out <directory>   where to save the App ID and the private key; must be
                      outside any Git repository

Options:
  --org <login>       create the App under this organization instead of your
                      personal account
  --homepage <url>    the App's homepage URL (default: the project's repository)
  --port <port>       the local port to listen on (default: a free port)
  --help              show this text
`;

/**
 * Runs the command and returns its exit code: 0 on success, 1 when the
 * registration fails, 2 for a usage error. Everything it prints goes through
 * `io`, and nothing it prints is a secret.
 */
export async function main(
  argv: readonly string[],
  io: CommandIo,
  deps: RegistrationDeps = {},
): Promise<number> {
  let parameters: RegistrationParameters;
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        app: { type: "string" },
        name: { type: "string" },
        org: { type: "string" },
        out: { type: "string" },
        homepage: { type: "string" },
        port: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      io.stdout.write(USAGE);
      return 0;
    }
    parameters = parseParameters(values);
  } catch (error) {
    if (error instanceof ParameterError || error instanceof TypeError) {
      io.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  try {
    const session = await startRegistration(parameters, deps);
    io.stdout.write(announce(parameters, session.url));
    io.stdout.write(summarize(await session.done));
    return 0;
  } catch (error) {
    if (error instanceof RegistrationError) {
      io.stderr.write(`${error.message}\n`);
    } else {
      const reason = error instanceof Error ? error.message : "unknown error";
      io.stderr.write(`Unexpected error: ${reason}\n`);
    }
    return 1;
  }
}

function announce(parameters: RegistrationParameters, url: string): string {
  const owner =
    parameters.org === undefined
      ? "your personal GitHub account"
      : `the organization ${parameters.org}`;
  return `Registering the ${parameters.kind} App "${parameters.name}" under ${owner}.

Open this page in the browser where you are signed in to GitHub:

  ${url}

Click "Continue to GitHub", then "Create GitHub App". GitHub then redirects
back here. The helper waits up to one hour, which is GitHub's limit for the
whole flow. Press Ctrl-C to stop.

`;
}

function summarize(result: RegistrationResult): string {
  return `Created the App "${result.name}" (ID ${result.appId}).

Saved, readable by you only:
  ${result.appIdPath}
  ${result.privateKeyPath}

Next:
  1. Move the private key into the role's keychain account, then delete the file.
  2. ${
    result.slug === undefined
      ? "Open your list of GitHub Apps, choose this App, then install it on the\n     repositories the instance serves:"
      : "Install the App on the repositories the instance serves:"
  }
     ${result.installUrl}

The client secret and the webhook secret were not saved: Forgecrew uses neither.
`;
}
