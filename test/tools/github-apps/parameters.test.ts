import { isAbsolute, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOMEPAGE_URL,
  ParameterError,
  parseParameters,
} from "../../../tools/github-apps/parameters.ts";

const valid = {
  app: "review-bot",
  name: "Example Review Bot",
  out: "/tmp/example-keys",
};

describe("parsing the registration parameters", () => {
  it("accepts the three required parameters and defaults the rest", () => {
    expect(parseParameters(valid)).toEqual({
      kind: "review-bot",
      name: "Example Review Bot",
      org: undefined,
      outDir: "/tmp/example-keys",
      homepageUrl: DEFAULT_HOMEPAGE_URL,
      port: 0,
    });
  });

  it("targets an organization when one is given", () => {
    expect(parseParameters({ ...valid, org: "example-org" }).org).toBe(
      "example-org",
    );
  });

  it("resolves a relative output directory against the working directory", () => {
    const { outDir } = parseParameters({ ...valid, out: "keys/review" });

    expect(isAbsolute(outDir)).toBe(true);
    expect(outDir).toBe(resolve("keys/review"));
  });

  it("accepts a homepage URL and a port", () => {
    const parsed = parseParameters({
      ...valid,
      homepage: "https://example.test/fork",
      port: "8123",
    });

    expect(parsed.homepageUrl).toBe("https://example.test/fork");
    expect(parsed.port).toBe(8123);
  });

  it.each([
    ["app", { app: undefined }, /--app/],
    ["name", { name: undefined }, /--name/],
    ["out", { out: undefined }, /--out/],
    ["app", { app: "" }, /--app/],
    ["name", { name: "   " }, /--name/],
    ["out", { out: "" }, /--out/],
  ])("requires --%s", (_flag, override, message) => {
    expect(() => parseParameters({ ...valid, ...override })).toThrow(
      ParameterError,
    );
    expect(() => parseParameters({ ...valid, ...override })).toThrow(message);
  });

  it("rejects an unknown App and names the valid ones", () => {
    expect(() => parseParameters({ ...valid, app: "dev-bot" })).toThrow(
      /review-bot, scheduler/,
    );
  });

  describe("the App name", () => {
    it.each(["a", "Example Review Bot", "my-bot_1.2", "Näme", "x".repeat(34)])(
      "accepts %j",
      (name) => {
        expect(parseParameters({ ...valid, name }).name).toBe(name);
      },
    );

    it.each([
      ["longer than GitHub's 34 characters", "x".repeat(35)],
      ["padded with whitespace", " padded "],
      ["holding a control character", "two\nlines"],
      ["holding markup", `"><script>alert(1)</script>`],
      ["without a letter or digit", "---"],
    ])("rejects a name %s", (_why, name) => {
      expect(() => parseParameters({ ...valid, name })).toThrow(ParameterError);
    });
  });

  describe("the organization", () => {
    it.each(["a", "example-org", "Org2", "a".repeat(39)])(
      "accepts %j",
      (org) => {
        expect(parseParameters({ ...valid, org }).org).toBe(org);
      },
    );

    it.each([
      "-leading",
      "trailing-",
      "double--hyphen",
      "has space",
      "a/b",
      "../escape",
      "a".repeat(40),
      "",
    ])("rejects %j", (org) => {
      expect(() => parseParameters({ ...valid, org })).toThrow(ParameterError);
    });
  });

  describe("the homepage URL", () => {
    it.each(["not a url", "ftp://example.test/", "javascript:alert(1)"])(
      "rejects %j",
      (homepage) => {
        expect(() => parseParameters({ ...valid, homepage })).toThrow(
          ParameterError,
        );
      },
    );
  });

  describe("the port", () => {
    it.each(["0", "80", "65535"])("accepts %j", (port) => {
      expect(parseParameters({ ...valid, port }).port).toBe(Number(port));
    });

    it.each(["abc", "-1", "65536", "1.5", "", " 80"])("rejects %j", (port) => {
      expect(() => parseParameters({ ...valid, port })).toThrow(ParameterError);
    });
  });
});
