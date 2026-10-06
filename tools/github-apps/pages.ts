import type { AppKind, AppManifest, PermissionGrant } from "./manifests.ts";

// The few pages the registration helper serves on the loopback address. They
// run no script and load nothing; every dynamic value goes through escapeHtml.

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface RegistrationPageView {
  readonly name: string;
  readonly kind: AppKind;
  /** The organization that will own the App; absent means the personal account. */
  readonly org: string | undefined;
  /** Where the form posts to: GitHub's registration page, with the state. */
  readonly action: string;
  readonly manifest: AppManifest;
  readonly grants: readonly PermissionGrant[];
}

export function renderRegistrationPage(view: RegistrationPageView): string {
  const owner =
    view.org === undefined
      ? "your personal GitHub account"
      : `the organization <strong>${escapeHtml(view.org)}</strong>`;
  const rows = view.grants
    .map(
      (grant) =>
        `<tr><td><code>${escapeHtml(grant.permission)}</code></td><td>${escapeHtml(grant.access)}</td><td>${escapeHtml(grant.why)}</td></tr>`,
    )
    .join("\n");

  return shell(
    "Register a Forgecrew GitHub App",
    `<h1>Register a GitHub App</h1>
<p>This registers <strong>${escapeHtml(view.name)}</strong> as the <code>${escapeHtml(view.kind)}</code> App under ${owner}.</p>
<p>The next page is GitHub's. Check the name and the permissions, then click <em>Create GitHub App</em>. GitHub sends you back here, and the helper saves the App ID and the private key without showing the key.</p>
<form method="post" action="${escapeHtml(view.action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(view.manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<h2>Permissions it requests</h2>
<table>
<thead><tr><th>Permission</th><th>Access</th><th>Why</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p>No webhook is active and no events are subscribed: Forgecrew polls.</p>
<details><summary>The manifest that will be sent</summary><pre>${escapeHtml(JSON.stringify(view.manifest, null, 2))}</pre></details>`,
  );
}

export interface SuccessPageView {
  readonly name: string;
  readonly appId: number;
  readonly appIdPath: string;
  readonly privateKeyPath: string;
  readonly installUrl: string;
  /** True when installUrl is the owner's list of Apps, not the App's install page. */
  readonly installFromList: boolean;
}

export function renderSuccessPage(view: SuccessPageView): string {
  return shell(
    "GitHub App created",
    `<h1>App created</h1>
<p><strong>${escapeHtml(view.name)}</strong> exists on GitHub with ID ${view.appId}. The helper saved:</p>
<ul>
<li><code>${escapeHtml(view.appIdPath)}</code></li>
<li><code>${escapeHtml(view.privateKeyPath)}</code>, readable by you only</li>
</ul>
<ol>
<li>Move the private key into the role's keychain account, then delete the file.</li>
${
  view.installFromList
    ? `<li><a href="${escapeHtml(view.installUrl)}" rel="noreferrer">Open your list of GitHub Apps</a>, choose this App, then install it on the repositories the instance serves.</li>`
    : `<li><a href="${escapeHtml(view.installUrl)}" rel="noreferrer">Install the App</a> on the repositories the instance serves.</li>`
}
</ol>
<p>The terminal shows the same steps. You can close this tab.</p>`,
  );
}

export function renderMessagePage(title: string, message: string): string {
  return shell(
    title,
    `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`,
  );
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; }
main { max-width: 46rem; margin: 0 auto; padding: 1rem; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #8884; padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; }
button { font: inherit; padding: 0.5rem 1rem; cursor: pointer; }
pre { overflow-x: auto; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
