import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  APP_KINDS,
  buildManifest,
  permissionGrants,
} from "../../../tools/github-apps/manifests.ts";

// The operator document repeats the permission tables so that the operator can
// hold them against GitHub's page. These tests keep it from drifting away from
// the manifests, which are the source of truth.

const doc = await readFile(
  new URL("../../../docs/github-apps.md", import.meta.url),
  "utf8",
);

function section(heading: string): string {
  const start = doc.indexOf(`\n### ${heading}\n`);
  expect(
    start,
    `docs/github-apps.md has a "### ${heading}" section`,
  ).toBeGreaterThan(-1);
  const rest = doc.slice(start + 1);
  const end = rest.slice(4).search(/^#{1,3} /m);
  return end === -1 ? rest : rest.slice(0, end + 4);
}

describe("docs/github-apps.md", () => {
  it.each(APP_KINDS)(
    "lists exactly the permissions of %s, with the manifest's reasons",
    (kind) => {
      const rows = permissionGrants(kind).map(
        (grant) =>
          `| \`${grant.permission}\` | ${grant.access} | ${grant.why} | ${grant.design.join(", ")} |`,
      );
      const text = section(kind);

      const missing = rows.filter((row) => !text.includes(row));
      expect(missing).toEqual([]);

      const documented = [
        ...text.matchAll(/^\| `(\w+)` \| (read|write) \|/gm),
      ].map((match) => [match[1], match[2]]);
      expect(Object.fromEntries(documented)).toEqual(
        buildManifest({
          kind,
          name: "x",
          homepageUrl: "https://x.test/",
          redirectUrl: "http://127.0.0.1/",
        }).default_permissions,
      );
    },
  );

  it.each(APP_KINDS)("shows the command for %s", (kind) => {
    expect(doc).toContain(`node tools/github-apps/register.ts --app ${kind}`);
  });

  it("links only to files and headings that exist", async () => {
    const links = [
      ...doc.matchAll(
        /\]\(((?:\.\.?\/|adr\/|design\.md)[^)#]*)(?:#([^)]*))?\)/g,
      ),
    ].map((match) => ({ path: match[1] as string, anchor: match[2] }));
    expect(links.length).toBeGreaterThan(0);

    for (const { path, anchor } of links) {
      const url = new URL(`../../../docs/${path}`, import.meta.url);
      await expect(stat(url), `docs/${path} exists`).resolves.toBeDefined();
      if (anchor !== undefined) {
        const target = await readFile(url, "utf8");
        const anchors = [...target.matchAll(/^#{1,6} (.+)$/gm)].map((heading) =>
          (heading[1] as string)
            .toLowerCase()
            .replaceAll(/[^a-z0-9 -]/g, "")
            .replaceAll(" ", "-"),
        );
        expect(anchors, `${path} has a heading for #${anchor}`).toContain(
          anchor,
        );
      }
    }
  });
});
