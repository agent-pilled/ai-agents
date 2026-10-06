import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  APP_KINDS,
  type AppKind,
  buildManifest,
  permissionGrants,
} from "../../../tools/github-apps/manifests.ts";

// The permission sets are the contract between the design and the Apps the
// operator creates by hand, so each test spells the expected set out in full
// instead of deriving it from the code under test.

const params = {
  name: "Example Review Bot",
  homepageUrl: "https://example.test/forgecrew",
  redirectUrl: "http://127.0.0.1:4567/callback",
};

const reviewBotPermissions = {
  checks: "write",
  contents: "read",
  issues: "read",
  metadata: "read",
  pull_requests: "write",
  statuses: "read",
};

const schedulerPermissions = {
  checks: "read",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
  statuses: "read",
};

// The parameters GitHub documents for a manifest:
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
const documentedManifestParameters = [
  "name",
  "url",
  "hook_attributes",
  "redirect_url",
  "callback_urls",
  "setup_url",
  "description",
  "public",
  "default_events",
  "default_permissions",
  "request_oauth_on_install",
  "setup_on_update",
];

describe("the App manifests", () => {
  it("define exactly the two Apps M1 needs", () => {
    expect(APP_KINDS).toEqual(["review-bot", "scheduler"]);
  });

  it("give the review-bot App exactly the permissions of the review lane", () => {
    const manifest = buildManifest({ kind: "review-bot", ...params });

    expect(manifest.default_permissions).toEqual(reviewBotPermissions);
  });

  it("give the scheduler App read access only", () => {
    const manifest = buildManifest({ kind: "scheduler", ...params });

    expect(manifest.default_permissions).toEqual(schedulerPermissions);
    expect(Object.values(manifest.default_permissions)).toEqual(
      Object.values(manifest.default_permissions).map(() => "read"),
    );
  });

  it.each(APP_KINDS)("never ask %s for administration or workflows", (kind) => {
    const { default_permissions } = buildManifest({ kind, ...params });

    expect(default_permissions).not.toHaveProperty("administration");
    expect(default_permissions).not.toHaveProperty("workflows");
    // Merging needs contents:write, and no lane or scheduler merges.
    expect(default_permissions).not.toHaveProperty("contents", "write");
  });

  it.each(APP_KINDS)(
    "poll only: %s has no webhook and no event subscriptions",
    (kind) => {
      const manifest = buildManifest({ kind, ...params });

      expect(manifest.hook_attributes.active).toBe(false);
      expect(manifest.default_events).toEqual([]);
    },
  );

  it.each(APP_KINDS)("keep %s private to the account that owns it", (kind) => {
    expect(buildManifest({ kind, ...params }).public).toBe(false);
  });

  it.each(APP_KINDS)("set no user-authorization flow for %s", (kind) => {
    const manifest = buildManifest({ kind, ...params });

    expect(manifest).not.toHaveProperty("callback_urls");
    expect(manifest).not.toHaveProperty("setup_url");
    expect(manifest).not.toHaveProperty("request_oauth_on_install");
  });

  it.each(APP_KINDS)(
    "use only parameters that GitHub documents for %s",
    (kind) => {
      const manifest = buildManifest({ kind, ...params });

      for (const key of Object.keys(manifest)) {
        expect(documentedManifestParameters).toContain(key);
      }
    },
  );

  it.each(APP_KINDS)(
    "carry the caller's name, homepage and redirect URL for %s",
    (kind) => {
      const manifest = buildManifest({ kind, ...params });

      expect(manifest.name).toBe(params.name);
      expect(manifest.url).toBe(params.homepageUrl);
      expect(manifest.redirect_url).toBe(params.redirectUrl);
      expect(manifest.description.length).toBeGreaterThan(0);
    },
  );
});

describe("the permission justifications", () => {
  it.each(APP_KINDS)(
    "cover every permission of %s, no more and no less",
    (kind) => {
      const manifest = buildManifest({ kind, ...params });
      const granted = Object.fromEntries(
        permissionGrants(kind).map((grant) => [grant.permission, grant.access]),
      );

      expect(granted).toEqual(manifest.default_permissions);
    },
  );

  it.each(APP_KINDS)(
    "give every permission of %s a one-line reason",
    (kind) => {
      for (const grant of permissionGrants(kind)) {
        expect(grant.why, grant.permission).toMatch(/\S/);
        expect(grant.why, grant.permission).not.toMatch(/\n/);
        expect(grant.design.length, grant.permission).toBeGreaterThan(0);
      }
    },
  );

  it.each(APP_KINDS)(
    "trace every permission of %s to a heading in docs/design.md",
    async (kind) => {
      const design = await readFile(
        new URL("../../../docs/design.md", import.meta.url),
        "utf8",
      );
      const headings = new Set(
        [...design.matchAll(/^#{2,4} (.+)$/gm)].map((match) => match[1]),
      );

      for (const grant of permissionGrants(kind)) {
        for (const section of grant.design) {
          expect(headings, `${grant.permission} cites "${section}"`).toContain(
            section,
          );
        }
      }
    },
  );

  it("list the permissions in alphabetical order, as GitHub does", () => {
    for (const kind of APP_KINDS satisfies readonly AppKind[]) {
      const names = permissionGrants(kind).map((grant) => grant.permission);
      expect(names).toEqual([...names].sort());
    }
  });
});
