import { resolve } from "node:path";
import { APP_KINDS, type AppKind } from "./manifests.ts";

/** The project's public address, which GitHub requires as the App's homepage. */
export const DEFAULT_HOMEPAGE_URL = "https://github.com/agent-pilled/ai-agents";

/** Raised for a parameter the operator can correct; the message says how. */
export class ParameterError extends Error {}

/** The parameters as the command line gives them, before validation. */
export interface RawParameters {
  readonly app?: string | undefined;
  readonly name?: string | undefined;
  readonly org?: string | undefined;
  readonly out?: string | undefined;
  readonly homepage?: string | undefined;
  readonly port?: string | undefined;
}

export interface RegistrationParameters {
  readonly kind: AppKind;
  readonly name: string;
  /** The organization that will own the App; absent means the personal account. */
  readonly org: string | undefined;
  /** Absolute. */
  readonly outDir: string;
  readonly homepageUrl: string;
  /** 0 lets the system choose a free port. */
  readonly port: number;
}

// GitHub caps an App name at 34 characters and turns special characters into
// hyphens in the App's slug:
// https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
// The name ends up in a page and in a manifest, so only plain words and a few
// separators pass.
const MAX_NAME_LENGTH = 34;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

// A GitHub login: alphanumeric characters or single hyphens, no hyphen at
// either end, at most 39 characters. It goes into a URL path, so it must be
// exactly that.
const ORG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function parseParameters(raw: RawParameters): RegistrationParameters {
  return {
    kind: parseKind(raw.app),
    name: parseName(raw.name),
    org: parseOrg(raw.org),
    outDir: resolve(required("--out", raw.out)),
    homepageUrl: parseHomepage(raw.homepage),
    port: parsePort(raw.port),
  };
}

function required(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new ParameterError(`${flag} is required.`);
  }
  return value;
}

function parseKind(value: string | undefined): AppKind {
  const app = required("--app", value);
  const kind = APP_KINDS.find((candidate) => candidate === app);
  if (kind === undefined) {
    throw new ParameterError(
      `--app must be one of: ${APP_KINDS.join(", ")} (got "${app}").`,
    );
  }
  return kind;
}

function parseName(value: string | undefined): string {
  const name = required("--name", value);
  if (name.trim() !== name) {
    throw new ParameterError("--name must not start or end with whitespace.");
  }
  if ([...name].length > MAX_NAME_LENGTH) {
    throw new ParameterError(
      `--name is longer than GitHub's ${MAX_NAME_LENGTH} characters.`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new ParameterError(
      "--name may contain only letters, digits, spaces, dots, hyphens and " +
        "underscores, and must start with a letter or digit.",
    );
  }
  return name;
}

function parseOrg(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!ORG_PATTERN.test(value)) {
    throw new ParameterError(`--org "${value}" is not a valid GitHub login.`);
  }
  return value;
}

function parseHomepage(value: string | undefined): string {
  if (value === undefined) return DEFAULT_HOMEPAGE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ParameterError(`--homepage "${value}" is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ParameterError("--homepage must be an http or https URL.");
  }
  return url.href;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 0;
  const port = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
  if (!(port >= 0 && port <= 65535)) {
    throw new ParameterError(
      `--port must be a whole number from 0 to 65535 (got "${value}").`,
    );
  }
  return port;
}
