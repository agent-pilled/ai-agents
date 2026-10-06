import { Secret } from "./secret.ts";

// The last step of the manifest flow: the temporary code that GitHub appends to
// the redirect URL buys the App's ID and private key.
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
// https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest

/**
 * What the operator needs from the conversion. Nothing else is kept. Only the
 * ID and the private key are essential: GitHub shows the operator no second
 * copy of the key, so a slug or name that looks odd must never cost it.
 */
export interface ConvertedApp {
  readonly id: number;
  /** Absent when GitHub's slug is not safe to put in a file name or a URL. */
  readonly slug: string | undefined;
  readonly name: string | undefined;
  readonly privateKey: Secret;
}

export interface ConversionOptions {
  /** `https://api.github.com`; tests point it at a stub. */
  readonly apiBaseUrl: string;
  readonly timeoutMs?: number;
}

/**
 * Raised for a failed exchange. The message says what failed and never quotes
 * GitHub's answer. What the operator does next depends on whether the App
 * exists, which this module cannot know, so the caller adds that.
 */
export class ConversionError extends Error {
  /**
   * True when GitHub may not have used the code, so a retry could still work: a
   * timeout, an unreachable GitHub, a server error or a rate limit. A retry
   * costs nothing when that guess is wrong, because GitHub then answers 404,
   * which is final. Any other refusal, and a malformed answer, is final.
   */
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.retryable = options.retryable ?? false;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
// GitHub derives the slug from the name and documents only that it is lowercased
// with spaces and special characters replaced. A slug outside this pattern is
// not used in a path or a URL.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function convertManifestCode(
  code: string,
  options: ConversionOptions,
): Promise<ConvertedApp> {
  const url = `${options.apiBaseUrl}/app-manifests/${encodeURIComponent(code)}/conversions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      // The endpoint takes no token: the code is the credential.
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "forgecrew-github-app-registration",
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ConversionError(describeNetworkFailure(error), {
      retryable: true,
    });
  }

  const text = await readText(response);

  if (response.status !== 201) {
    throw new ConversionError(describeRefusal(response.status, text), {
      retryable: mayRetry(response),
    });
  }

  const app = parseConvertedApp(text);
  if (app === undefined) {
    throw new ConversionError(
      "GitHub's answer to the conversion did not have the expected fields.",
    );
  }
  return app;
}

// GitHub signals a rate limit with 403 or 429, marked by an exhausted
// x-ratelimit-remaining or by retry-after.
function mayRetry({ status, headers }: Response): boolean {
  return (
    status >= 500 ||
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" ||
        headers.has("retry-after")))
  );
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function describeNetworkFailure(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "The request to GitHub timed out.";
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
  return `Could not reach GitHub${code ? ` (${code})` : ""}.`;
}

// Only GitHub's own `message` is shown, never the rest of the body.
function describeRefusal(status: number, text: string): string {
  const message = refusalMessage(text);
  const reason = message === undefined ? "" : `: ${message}`;
  const hint =
    status === 404
      ? " The code is unknown, has expired (it lasts one hour) or has already been used."
      : status === 422
        ? " Validation failed, or the endpoint has been called too often."
        : "";
  return `GitHub answered ${status} to the conversion${reason}.${hint}`;
}

function refusalMessage(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return body.message.slice(0, 200);
    }
  } catch {
    // Not JSON: say nothing about the body.
  }
  return undefined;
}

function parseConvertedApp(text: string): ConvertedApp | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;

  const { id, slug, name, pem } = body as Record<string, unknown>;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof pem !== "string" ||
    !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)
  ) {
    return undefined;
  }
  return {
    id,
    slug:
      typeof slug === "string" && SLUG_PATTERN.test(slug) ? slug : undefined,
    name: typeof name === "string" && name !== "" ? name : undefined,
    privateKey: new Secret(pem),
  };
}
