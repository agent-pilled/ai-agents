// The GitHub App manifests for the Apps that M1 creates by hand.
//
// Each App gets the least privilege its role needs, derived from
// docs/design.md. GitHub offers no way to create an App without a human, but
// the manifest flow turns the form into one prefilled page and a click:
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//
// The permission names and what each one allows are listed in
// https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
// and, for the parameterized names used below, under the `permissions` body
// parameter of
// https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app

export const APP_KINDS = ["review-bot", "scheduler"] as const;
export type AppKind = (typeof APP_KINDS)[number];

export type PermissionName =
  | "checks"
  | "contents"
  | "issues"
  | "metadata"
  | "pull_requests"
  | "statuses";
export type Access = "read" | "write";

export interface PermissionGrant {
  readonly permission: PermissionName;
  readonly access: Access;
  /** One line: what the App does with the permission. */
  readonly why: string;
  /** The headings of docs/design.md that call for it. */
  readonly design: readonly string[];
}

export interface ManifestParameters {
  readonly kind: AppKind;
  /** The instance's name for the App; GitHub lets the operator edit it. */
  readonly name: string;
  readonly homepageUrl: string;
  /** Where GitHub sends the operator, with the temporary code, after Create. */
  readonly redirectUrl: string;
}

export interface AppManifest {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly redirect_url: string;
  readonly public: false;
  readonly hook_attributes: { readonly url: string; readonly active: false };
  readonly default_events: readonly never[];
  readonly default_permissions: Readonly<
    Partial<Record<PermissionName, Access>>
  >;
}

// The scheduler and every lane poll the forge; nothing needs inbound access
// (docs/adr/0004-polling-with-a-derived-scheduler.md). GitHub still asks for a
// URL whenever a manifest carries hook_attributes, so the inactive hook gets
// a reserved documentation address that no delivery will ever reach.
const INACTIVE_WEBHOOK_URL = "https://example.com/";

const metadata: PermissionGrant = {
  permission: "metadata",
  access: "read",
  why: "Repository metadata, which GitHub adds read-only to any App with repository permissions; listed so the manifest shows the whole set.",
  design: ["Dispatcher"],
};

const grants: Readonly<Record<AppKind, readonly PermissionGrant[]>> = {
  "review-bot": [
    {
      permission: "checks",
      access: "write",
      why: "Create and update the lane's check run: the claim on the captured head, then the verdict the ruleset requires.",
      design: ["Verdicts and gates", "Dispatcher"],
    },
    {
      permission: "contents",
      access: "read",
      why: "Fetch the change into the warm mirrors and read the base branch's agent instruction files; never write, so it cannot merge.",
      design: ["Broker", "Environment"],
    },
    {
      permission: "issues",
      access: "read",
      why: "Read the linked issue and its comments within the role's read scope.",
      design: ["Broker"],
    },
    metadata,
    {
      permission: "pull_requests",
      access: "write",
      why: "Post findings and replies in review threads and comment on the change to escalate; never submit an approval.",
      design: ["Pass contract", "Rounds and escalation"],
    },
    {
      permission: "statuses",
      access: "read",
      why: "Read commit statuses to tell whether CI is green on the head; check runs come with the checks permission.",
      design: ["Signals"],
    },
  ],
  scheduler: [
    {
      permission: "checks",
      access: "read",
      why: "See completed CI, completed lane verdicts and in-progress claims that no dispatcher holds.",
      design: ["Scheduler", "Signals", "Failure handling"],
    },
    {
      permission: "issues",
      access: "read",
      why: "Find mentions on issues and read issue relations such as blocked_by.",
      design: ["Scheduler", "Signals"],
    },
    metadata,
    {
      permission: "pull_requests",
      access: "read",
      why: "List changes with their heads, comments and reviews updated since the last poll.",
      design: ["Scheduler"],
    },
    {
      permission: "statuses",
      access: "read",
      why: "See completed commit statuses, which count as CI beside check runs.",
      design: ["Signals"],
    },
  ],
};

const descriptions: Readonly<Record<AppKind, string>> = {
  "review-bot":
    "Forgecrew code-review lane. Records its verdict as a check run and posts review findings. Polls; no webhook.",
  scheduler:
    "Forgecrew scheduler. Reads pull requests, issues and checks to discover work. Read-only; polls; no webhook.",
};

export function permissionGrants(kind: AppKind): readonly PermissionGrant[] {
  return grants[kind];
}

export function buildManifest(parameters: ManifestParameters): AppManifest {
  const { kind, name, homepageUrl, redirectUrl } = parameters;
  return {
    name,
    url: homepageUrl,
    description: descriptions[kind],
    redirect_url: redirectUrl,
    public: false,
    hook_attributes: { url: INACTIVE_WEBHOOK_URL, active: false },
    default_events: [],
    default_permissions: Object.fromEntries(
      grants[kind].map((grant) => [grant.permission, grant.access]),
    ),
  };
}
