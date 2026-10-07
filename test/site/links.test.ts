import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brokenLinks, SITE_URL, type Site } from "./links.ts";

// The site is plain files with no build step, so nothing but this test notices
// a link to a page, a file or a heading that does not exist. html.test.ts
// checks the markup itself.

const SITE_DIR = fileURLToPath(new URL("../../site/", import.meta.url));

async function readSite(): Promise<Site> {
  const files = new Map<string, string | undefined>();
  for (const entry of await readdir(SITE_DIR, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const path = relative(SITE_DIR, file).split(sep).join("/");
    files.set(
      path,
      path.endsWith(".html") ? await readFile(file, "utf8") : undefined,
    );
  }
  return { files };
}

function site(files: Record<string, string | undefined>): Site {
  return { files: new Map(Object.entries(files)) };
}

describe("brokenLinks", () => {
  it("accepts relative, root-relative and absolute links to files and ids that exist", async () => {
    const example = site({
      "index.html": `<!doctype html><html lang="en"><head><title>t</title>
        <link rel="stylesheet" href="style.css">
        <link rel="icon" href="/forgecrew/favicon.svg">
        <meta property="og:url" content="${SITE_URL}">
        <meta property="og:image" content="${SITE_URL}card.png">
        </head><body><h1 id="top-heading">t</h1>
        <a href="#top-heading">here</a>
        <a href="./">home</a>
        <a href="docs/guide.html#install">guide</a>
        <img src="card.png" alt="card">
        </body></html>`,
      "docs/guide.html": `<!doctype html><html lang="en"><head><title>g</title></head>
        <body><h1 id="install">i</h1><a href="../index.html#top-heading">back</a>
        <a href="/forgecrew/">home</a></body></html>`,
      "style.css": undefined,
      "favicon.svg": undefined,
      "card.png": undefined,
    });

    expect(await brokenLinks(example, "index.html")).toEqual([]);
    expect(await brokenLinks(example, "docs/guide.html")).toEqual([]);
  });

  it("reports a link to a file that does not exist", async () => {
    const example = site({
      "index.html": `<p><a href="missing.html">x</a></p>
        <link rel="stylesheet" href="/forgecrew/missing.css">
        <meta property="og:image" content="${SITE_URL}missing.png">`,
    });

    expect(await brokenLinks(example, "index.html")).toEqual([
      {
        page: "index.html",
        link: "missing.html",
        problem: "no file missing.html in the site",
      },
      {
        page: "index.html",
        link: "/forgecrew/missing.css",
        problem: "no file missing.css in the site",
      },
      {
        page: "index.html",
        link: `${SITE_URL}missing.png`,
        problem: "no file missing.png in the site",
      },
    ]);
  });

  it("checks every attribute that names a file, in document order", async () => {
    const example = site({
      "index.html": `<map name="m"><area href="missing-area.html" alt="a"></map>
        <iframe src="missing-frame.html" title="f"></iframe>
        <video src="missing.mp4" poster="missing-poster.png">
          <track src="missing.vtt"></video>
        <audio src="missing.ogg"></audio>
        <img src="here.png" srcset="here.png, missing-2x.png 2x,missing-wide.png 800w" alt="x">
        <object data="missing.pdf"></object>
        <form action="missing-form.html"><button formaction="missing-button.html">go</button></form>
        <input type="image" src="missing-input.png" alt="go">
        <embed src="missing.svg">
        <meta name="twitter:image" content="${SITE_URL}missing-card.png">`,
      "here.png": undefined,
    });

    expect(
      (await brokenLinks(example, "index.html")).map(({ link }) => link),
    ).toEqual([
      "missing-area.html",
      "missing-frame.html",
      "missing.mp4",
      "missing-poster.png",
      "missing.vtt",
      "missing.ogg",
      "missing-2x.png",
      "missing-wide.png",
      "missing.pdf",
      "missing-form.html",
      "missing-button.html",
      "missing-input.png",
      "missing.svg",
      `${SITE_URL}missing-card.png`,
    ]);
  });

  it("resolves links against a base element, which is not a link itself", async () => {
    const example = site({
      "index.html": `<base href="docs/"><a href="guide.html">g</a>
        <a href="missing.html">m</a>`,
      "docs/guide.html": "",
    });

    expect(await brokenLinks(example, "index.html")).toEqual([
      {
        page: "index.html",
        link: "missing.html",
        problem: "no file docs/missing.html in the site",
      },
    ]);
  });

  it("reports a fragment that names no id on its page", async () => {
    const example = site({
      "index.html": `<h1 id="here">x</h1><a href="#elsewhere">x</a>
        <a href="other.html#here">x</a>`,
      "other.html": `<h1 id="there">y</h1>`,
    });

    expect(await brokenLinks(example, "index.html")).toEqual([
      {
        page: "index.html",
        link: "#elsewhere",
        problem: "index.html has no id elsewhere",
      },
      {
        page: "index.html",
        link: "other.html#here",
        problem: "other.html has no id here",
      },
    ]);
  });

  it("resolves a directory link to its index.html", async () => {
    const example = site({
      "index.html": `<a href="guide/">guide</a>`,
      "guide/index.html": `<a href="../">home</a>`,
    });

    expect(await brokenLinks(example, "index.html")).toEqual([]);
    expect(await brokenLinks(example, "guide/index.html")).toEqual([]);
    expect(
      await brokenLinks(
        site({ "index.html": `<a href="guide/">x</a>` }),
        "index.html",
      ),
    ).toEqual([
      {
        page: "index.html",
        link: "guide/",
        problem: "no file guide/index.html in the site",
      },
    ]);
  });

  it("ignores links that leave the site", async () => {
    const example = site({
      "index.html": `<a href="https://github.com/mvasin/forgecrew">repo</a>
        <a href="https://mvasin.github.io/">another site on the same host</a>
        <a href="/elsewhere/page.html">another path on the same host</a>
        <a href="mailto:someone@example.test">mail</a>`,
    });

    expect(await brokenLinks(example, "index.html")).toEqual([]);
  });

  it("resolves links against the address a page is served at, except a bare fragment", async () => {
    const notFound = site({
      "404.html": `<link rel="stylesheet" href="style.css"><a href="./">home</a>
        <a href="#main">skip</a><main id="main"></main>`,
      "style.css": undefined,
      "index.html": "",
    });

    expect(await brokenLinks(notFound, "404.html")).toEqual([]);
    expect(
      await brokenLinks(notFound, "404.html", "some/missing/page"),
    ).toEqual([
      {
        page: "404.html",
        link: "style.css",
        problem: "no file some/missing/style.css in the site",
      },
      {
        page: "404.html",
        link: "./",
        problem: "no file some/missing/index.html in the site",
      },
    ]);
  });
});

describe("the site", async () => {
  const published = await readSite();
  const pages = [...published.files.keys()].filter((path) =>
    path.endsWith(".html"),
  );

  it("has a home page and a page for missing addresses", () => {
    expect(pages).toEqual(expect.arrayContaining(["index.html", "404.html"]));
  });

  it.each(pages)(
    "links only to files and ids that exist from %s",
    async (page) => {
      expect(await brokenLinks(published, page)).toEqual([]);
    },
  );

  // GitHub Pages answers every missing address with 404.html, at whatever depth
  // the address has, so its links must not depend on where it is served.
  it("serves 404.html with working links at any missing address", async () => {
    expect(
      await brokenLinks(published, "404.html", "no/such/page.html"),
    ).toEqual([]);
  });
});
