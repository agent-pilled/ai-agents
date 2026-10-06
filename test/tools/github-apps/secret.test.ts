import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Secret } from "../../../tools/github-apps/secret.ts";

describe("a secret", () => {
  const secret = new Secret("fake-secret-value");

  it("gives its value back only when asked", () => {
    expect(secret.reveal()).toBe("fake-secret-value");
  });

  it.each([
    ["a template string", () => `${secret}`],
    ["string concatenation", () => `key: ${String(secret)}`],
    ["JSON", () => JSON.stringify({ secret })],
    ["util.inspect", () => inspect({ secret }, { depth: 5 })],
    [
      "util.format, which console.log uses",
      () => format("%s %o %j", secret, secret, secret),
    ],
  ])("stays out of %s", (_name, render) => {
    const output = render();

    expect(output).not.toContain("fake-secret-value");
    expect(output).toContain("[redacted]");
  });
});
