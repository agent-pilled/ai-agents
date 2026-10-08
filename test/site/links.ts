import { type HtmlElement, HtmlValidate, Parser } from "html-validate";

// Finds the links on one page of the site that point into the site but reach
// no file, or no element with the fragment's id. A link points into the site
// when it resolves under the address GitHub Pages serves the site at.

export const SITE_URL = "https://agents.agent-pilled.com/";

export interface Site {
  /** Every file by its path from the site root, with the source of each HTML page. */
  readonly files: ReadonlyMap<string, string | undefined>;
}

export interface BrokenLink {
  readonly page: string;
  readonly link: string;
  readonly problem: string;
}

/**
 * The attributes that name a file, in the order an element's are checked:
 * every `href` and `src`, the candidates of every `srcset`, every `poster`,
 * `data` on `object`, `action` on `form`, every `formaction`, and the address
 * and image of a link preview. `href` on `base` sets the base address instead.
 */
const LINK_ATTRIBUTES: readonly {
  readonly attribute: string;
  readonly on?: string;
  readonly list?: boolean;
}[] = [
  { attribute: "href" },
  { attribute: "src" },
  { attribute: "srcset", list: true },
  { attribute: "poster" },
  { attribute: "data", on: "object" },
  { attribute: "action", on: "form" },
  { attribute: "formaction" },
  {
    attribute: "content",
    on: 'meta[property="og:url"], meta[property="og:image"], meta[name="twitter:image"]',
  },
];

/**
 * Checks the links on `page`, resolved as if the page were served at
 * `servedAt`, both paths from the site root.
 */
export async function brokenLinks(
  site: Site,
  page: string,
  servedAt: string = page,
): Promise<BrokenLink[]> {
  const root = await parse(site, page);
  const address = new URL(servedAt, SITE_URL);
  const baseHref = root.querySelector("base[href]")?.getAttributeValue("href");
  const base = baseHref == null ? address : new URL(baseHref, address);

  const broken: BrokenLink[] = [];
  for (const link of links(root)) {
    const url = new URL(link, base);
    const problem = sameDocument(url, address)
      ? missingId(root, page, url)
      : await check(site, url);
    if (problem !== undefined) broken.push({ page, link, problem });
  }
  return broken;
}

/** Every link on the page, in document order. */
function* links(element: HtmlElement): Generator<string> {
  for (const child of element.childElements) {
    if (!child.is("base")) {
      for (const { attribute, on, list } of LINK_ATTRIBUTES) {
        if (on !== undefined && !child.matches(on)) continue;
        const value = child.getAttributeValue(attribute);
        if (value === null) continue;
        yield* list ? srcsetUrls(value) : [value];
      }
    }
    yield* links(child);
  }
}

/** The URLs of a `srcset`: each candidate is a URL, then optional descriptors. */
function srcsetUrls(srcset: string): string[] {
  const urls: string[] = [];
  let rest = srcset;
  for (;;) {
    rest = rest.replace(/^[\s,]+/, "");
    const url = rest.match(/^\S+/)?.[0];
    if (url === undefined) return urls;
    rest = rest.slice(url.length);
    if (url.endsWith(",")) {
      urls.push(url.replace(/,+$/, ""));
      continue;
    }
    urls.push(url);
    const comma = rest.indexOf(",");
    if (comma === -1) return urls;
    rest = rest.slice(comma + 1);
  }
}

function sameDocument(url: URL, address: URL): boolean {
  return withoutFragment(url) === withoutFragment(address);
}

function withoutFragment(url: URL): string {
  return url.href.replace(/#.*$/, "");
}

async function check(site: Site, url: URL): Promise<string | undefined> {
  if (!url.href.startsWith(SITE_URL)) return undefined;

  let path = decodeURIComponent(url.pathname).slice(
    new URL(SITE_URL).pathname.length,
  );
  if (path === "" || path.endsWith("/")) path += "index.html";
  if (!site.files.has(path)) return `no file ${path} in the site`;
  return url.hash === ""
    ? undefined
    : missingId(await parse(site, path), path, url);
}

function missingId(
  root: HtmlElement,
  path: string,
  url: URL,
): string | undefined {
  const id = decodeURIComponent(url.hash.slice(1));
  if (id === "") return undefined;
  return root.querySelectorAll("[id]").some((element) => element.id === id)
    ? undefined
    : `${path} has no id ${id}`;
}

const htmlvalidate = new HtmlValidate();
const parsed = new WeakMap<Site, Map<string, HtmlElement>>();

async function parse(site: Site, path: string): Promise<HtmlElement> {
  let pages = parsed.get(site);
  if (pages === undefined) {
    pages = new Map();
    parsed.set(site, pages);
  }
  const cached = pages.get(path);
  if (cached !== undefined) return cached;

  const source = site.files.get(path);
  if (source === undefined) throw new Error(`${path} is not an HTML page`);
  const config = await htmlvalidate.getConfigFor(path);
  const root = new Parser(config).parseHtml(source);
  pages.set(path, root);
  return root;
}
