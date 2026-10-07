import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FileSystemConfigLoader,
  HtmlValidate,
  type Message,
} from "html-validate";
import { describe, expect, it } from "vitest";

// Validates every page of the site with html-validate and the repository's
// .htmlvalidate.json: the recommended rules for markup and accessibility, and
// the rules for whole documents, such as a doctype and heading order.

const SITE_DIR = fileURLToPath(new URL("../../site/", import.meta.url));
// The default loader ignores configuration files; this one reads
// .htmlvalidate.json the way the html-validate command does.
const htmlvalidate = new HtmlValidate(new FileSystemConfigLoader());

function describeMessage(message: Message): string {
  return `${message.line}:${message.column} ${message.ruleId}: ${message.message}`;
}

async function problems(path: string, source?: string): Promise<string[]> {
  const report =
    source === undefined
      ? await htmlvalidate.validateFile(path)
      : await htmlvalidate.validateString(source, path);
  return report.results.flatMap((result) =>
    result.messages.map(describeMessage),
  );
}

describe("the HTML rules", () => {
  // Proves the configuration is in force: the problems come from the document
  // preset, the recommended preset and the tuned integrity rule.
  it("reject a page with no doctype, a skipped heading level, an image without text or a stylesheet from elsewhere without integrity", async () => {
    const found = await problems(
      join(SITE_DIR, "example.html"),
      `<html lang="en"><head><title>t</title>
<link rel="stylesheet" href="https://cdn.example.test/x.css" crossorigin="anonymous"></head>
<body><h1>t</h1><h3>skipped</h3><img src="x.png"></body></html>
`,
    );

    expect(found).toEqual([
      expect.stringContaining("missing-doctype"),
      expect.stringContaining("require-sri"),
      expect.stringContaining("heading-level"),
      expect.stringContaining("wcag/h37"),
    ]);
  });

  it("accept a stylesheet from the site itself without integrity", async () => {
    const found = await problems(
      join(SITE_DIR, "example.html"),
      `<!DOCTYPE html><html lang="en"><head><title>t</title>
<link rel="stylesheet" href="style.css"></head><body><h1>t</h1></body></html>
`,
    );

    expect(found).toEqual([]);
  });
});

describe("the site", async () => {
  const pages = (await readdir(SITE_DIR, { recursive: true })).filter((path) =>
    path.endsWith(".html"),
  );

  it("has pages to validate", () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it.each(pages)("%s is valid HTML", async (page) => {
    expect(await problems(join(SITE_DIR, page))).toEqual([]);
  });
});
