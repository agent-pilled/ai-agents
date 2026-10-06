import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { ConversionError, convertManifestCode } from "./conversion.ts";
import {
  CredentialsError,
  prepareOutputDirectory,
  saveCredentials,
} from "./credentials.ts";
import { buildManifest, permissionGrants } from "./manifests.ts";
import {
  renderMessagePage,
  renderRegistrationPage,
  renderSuccessPage,
} from "./pages.ts";
import type { RegistrationParameters } from "./parameters.ts";

// The manifest flow, driven from a loopback web server:
//   1. the operator opens the helper's page, which posts the manifest to GitHub;
//   2. the operator clicks Create on GitHub, which redirects back here with a
//      temporary code and the state that the page sent;
//   3. the helper exchanges the code and saves the App ID and private key.
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest

export interface Endpoints {
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;
}

export const GITHUB_ENDPOINTS: Endpoints = {
  webBaseUrl: "https://github.com",
  apiBaseUrl: "https://api.github.com",
};

export interface RegistrationDeps {
  readonly endpoints?: Endpoints;
  /** How long to wait for GitHub's redirect. */
  readonly timeoutMs?: number;
}

export interface RegistrationResult {
  readonly appId: number;
  /** Absent when GitHub's slug was not safe to use; the files are named by ID. */
  readonly slug: string | undefined;
  readonly name: string;
  readonly appIdPath: string;
  readonly privateKeyPath: string;
  /**
   * Where the operator installs the App next: the App's install page, or the
   * owner's list of Apps when the slug was unusable.
   */
  readonly installUrl: string;
}

export interface RegistrationSession {
  /** The page the operator opens in the browser where GitHub is signed in. */
  readonly url: string;
  /** Settles once: with the saved credentials, or with a RegistrationError. */
  readonly done: Promise<RegistrationResult>;
  /** Stops listening. If the registration is still open, it fails as cancelled. */
  close(): Promise<void>;
}

/** Raised for any failure the operator should read; the message is safe to print. */
export class RegistrationError extends Error {}

// GitHub requires all three steps of the flow within one hour, so the helper
// listens for as long as a redirect could still be exchanged.
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
// GitHub redirects here only after the operator clicks Create GitHub App, so by
// the time anything has failed the App exists and its name is taken.
const APP_EXISTS =
  "GitHub has already created the App, because it redirects here only after Create GitHub App.";

const DEFAULT_TIMEOUT_MS = 60 * 60_000;

export async function startRegistration(
  parameters: RegistrationParameters,
  deps: RegistrationDeps = {},
): Promise<RegistrationSession> {
  const endpoints = deps.endpoints ?? GITHUB_ENDPOINTS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    await prepareOutputDirectory(parameters.outDir);
  } catch (error) {
    throw new RegistrationError(
      error instanceof CredentialsError
        ? error.message
        : "The output directory is unusable.",
    );
  }

  const state = randomBytes(24).toString("base64url");
  let origin = "";
  let allowedHosts: ReadonlySet<string> = new Set();
  let exchanging = false;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  let resolveDone: (result: RegistrationResult) => void = () => undefined;
  let rejectDone: (error: RegistrationError) => void = () => undefined;
  const done = new Promise<RegistrationResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // The caller may await `done` later than it rejects.
  done.catch(() => undefined);

  const server = createServer((request, response) => {
    void route(request, response).catch(() =>
      send(
        response,
        500,
        renderMessagePage(
          "Something went wrong",
          "The helper hit an unexpected error.",
        ),
      ),
    );
  });

  function settle(outcome: RegistrationResult | RegistrationError): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (outcome instanceof RegistrationError) rejectDone(outcome);
    else resolveDone(outcome);
    server.close();
    server.closeAllConnections();
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!allowedHosts.has(request.headers.host ?? "")) {
      await send(
        response,
        403,
        renderMessagePage(
          "Refused",
          "This address is not the helper's loopback address.",
        ),
      );
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    if (request.method !== "GET") {
      await send(
        response,
        405,
        renderMessagePage("Not allowed", "Only GET is served here."),
      );
    } else if (url.pathname === "/") {
      await send(response, 200, registrationPage());
    } else if (url.pathname === "/callback") {
      await callback(url, response);
    } else {
      await send(
        response,
        404,
        renderMessagePage("Not found", "There is nothing at this address."),
      );
    }
  }

  function registrationPage(): string {
    const base = endpoints.webBaseUrl;
    const target =
      parameters.org === undefined
        ? `${base}/settings/apps/new`
        : `${base}/organizations/${parameters.org}/settings/apps/new`;
    return renderRegistrationPage({
      name: parameters.name,
      kind: parameters.kind,
      org: parameters.org,
      action: `${target}?state=${state}`,
      manifest: buildManifest({
        kind: parameters.kind,
        name: parameters.name,
        homepageUrl: parameters.homepageUrl,
        redirectUrl: `${origin}/callback`,
      }),
      grants: permissionGrants(parameters.kind),
    });
  }

  async function callback(url: URL, response: ServerResponse): Promise<void> {
    if (!sameState(url.searchParams.get("state"), state)) {
      await send(
        response,
        400,
        renderMessagePage(
          "Refused",
          "The state does not match this registration. Start again from the helper's page.",
        ),
      );
      return;
    }
    const code = url.searchParams.get("code");
    if (code === null || code === "") {
      await send(
        response,
        400,
        renderMessagePage("Refused", "GitHub sent no code."),
      );
      return;
    }
    if (exchanging) {
      await send(
        response,
        409,
        renderMessagePage(
          "Busy",
          "This registration is already being completed.",
        ),
      );
      return;
    }
    exchanging = true;
    // From here the redirect has arrived. A timeout must not cut the exchange
    // short and leave the App created but its key unsaved.
    clearTimeout(timer);

    let app: Awaited<ReturnType<typeof convertManifestCode>>;
    try {
      app = await convertManifestCode(code, {
        apiBaseUrl: endpoints.apiBaseUrl,
      });
    } catch (error) {
      const failure =
        error instanceof ConversionError
          ? error
          : new ConversionError("The conversion failed.");
      if (failure.retryable) {
        // GitHub may never have seen the request, so the code may be unused:
        // let the operator reload this URL instead of orphaning the App.
        exchanging = false;
        armTimeout();
        await send(
          response,
          502,
          renderMessagePage(
            "The App could not be completed yet",
            `${failure.message} The temporary code may still be unused. Reload this page to try again. If reloading keeps failing, do not start again yet. ${APP_EXISTS} ${afterCreateAdvice()}`,
          ),
        );
        return;
      }
      const message = `${failure.message} ${APP_EXISTS} ${afterCreateAdvice()}`;
      await send(
        response,
        502,
        renderMessagePage("The App could not be completed", message),
      );
      settle(new RegistrationError(message));
      return;
    }

    try {
      const saved = await saveCredentials(parameters.outDir, app);
      const result: RegistrationResult = {
        appId: app.id,
        slug: app.slug,
        name: app.name ?? parameters.name,
        appIdPath: saved.appIdPath,
        privateKeyPath: saved.privateKeyPath,
        installUrl:
          app.slug === undefined
            ? appsUrl()
            : `${endpoints.webBaseUrl}/apps/${app.slug}/installations/new`,
      };
      await send(
        response,
        200,
        renderSuccessPage({
          ...result,
          installFromList: app.slug === undefined,
        }),
      );
      settle(result);
    } catch (error) {
      const reason =
        error instanceof CredentialsError
          ? error.message
          : "The files could not be written.";
      const message = `GitHub created the App, but its credentials could not be saved. ${reason} The private key cannot be fetched again: generate a new one on ${settingsUrl(app.slug)}, or delete the App and start again.`;
      await send(
        response,
        500,
        renderMessagePage("The credentials were not saved", message),
      );
      settle(new RegistrationError(message));
    }
  }

  function appsUrl(): string {
    const base = endpoints.webBaseUrl;
    return parameters.org === undefined
      ? `${base}/settings/apps`
      : `${base}/organizations/${parameters.org}/settings/apps`;
  }

  function settingsUrl(slug: string | undefined): string {
    return slug === undefined ? appsUrl() : `${appsUrl()}/${slug}`;
  }

  function afterCreateAdvice(): string {
    return `Starting again with the same name will fail while the App exists. Open ${appsUrl()}, then generate a private key on the App's settings page, or delete the App before starting again.`;
  }

  function armTimeout(): void {
    // A session closed during an exchange has settled; a new timer would only
    // keep the process alive.
    if (settled) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      settle(
        new RegistrationError(
          `Timed out after ${describeDuration(timeoutMs)} without a redirect from GitHub. If you clicked Create GitHub App, the App exists and its key was not saved. ${afterCreateAdvice()}`,
        ),
      );
    }, timeoutMs);
  }

  const port = await listen(server, parameters.port);
  origin = `http://127.0.0.1:${port}`;
  allowedHosts = loopbackHosts(port);
  armTimeout();

  return {
    url: `${origin}/`,
    done,
    close: async () => {
      settle(new RegistrationError("The registration was cancelled."));
      await new Promise<void>((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
    },
  };
}

/**
 * The Host headers a request to the helper may carry. A browser omits the
 * default port from the header (`new URL("http://127.0.0.1:80/").host` is
 * `127.0.0.1`), so port 80 is written without it.
 */
export function loopbackHosts(port: number): ReadonlySet<string> {
  const suffix = port === 80 ? "" : `:${port}`;
  return new Set([`127.0.0.1${suffix}`, `localhost${suffix}`]);
}

function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function sameState(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Resolves once the response has been handed to the network, or the browser
// has gone away.
function send(
  response: ServerResponse,
  status: number,
  html: string,
): Promise<void> {
  return new Promise((resolve) => {
    if (response.headersSent) {
      response.destroy();
      resolve();
      return;
    }
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      connection: "close",
    });
    response.once("close", resolve);
    response.end(html, () => resolve());
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new RegistrationError(
          error.code === "EADDRINUSE"
            ? `Port ${port} is already in use. Choose another with --port, or omit it to let the system choose.`
            : `Could not listen on 127.0.0.1:${port} (${error.code ?? "unknown error"}).`,
        ),
      );
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}
