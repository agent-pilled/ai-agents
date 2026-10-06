import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import { afterEach, describe, expect, it } from "vitest";

// Each test writes a small source tree to a temporary directory and cruises it
// with the repository's own .dependency-cruiser.cjs, so the rule itself is what
// is under test.

describe("the dependency rule", () => {
  it("accepts a core that imports only the core, adapters that import the core and a root that imports both", async () => {
    const violations = await cruiseTree({
      "src/core/ports/example.ts": `
        export interface Example {
          readonly name: string;
        }
      `,
      "src/core/domain/uses-port.ts": `
        import type { Example } from "../ports/example.ts";
        export type Alias = Example;
      `,
      "src/adapters/forge/example.ts": `
        import { join } from "node:path";
        import { sdk } from "@octokit/rest";
        import type { Example } from "../../core/ports/example.ts";
        export const example: Example = { name: join("a", sdk.name) };
      `,
      "src/main.ts": `
        import { example } from "./adapters/forge/example.ts";
        import type { Alias } from "./core/domain/uses-port.ts";
        export const wired: Alias = example;
      `,
      ...sdkPackage("@octokit/rest"),
    });

    expect(violations).toEqual([]);
  });

  it.each(coreImportsOfAnAdapter)(
    "rejects a core module with $name of an adapter",
    async ({ source }) => {
      const violations = await cruiseTree({
        "src/core/domain/uses-adapter.ts": source,
        "src/adapters/forge/adapter.ts": adapterSource,
      });

      expect(violations).toEqual([
        {
          rule: "core-never-reaches-adapter",
          severity: "error",
          from: "src/core/domain/uses-adapter.ts",
          to: "src/adapters/forge/adapter.ts",
          via: ["src/adapters/forge/adapter.ts"],
        },
      ]);
    },
  );

  it.each(coreReachesAnAdapterThrough)(
    "rejects a core module that reaches an adapter through $name",
    async ({ files, via }) => {
      const violations = await cruiseTree({
        ...files,
        "src/adapters/forge/adapter.ts": adapterSource,
      });

      expect(violations).toEqual([
        {
          rule: "core-never-reaches-adapter",
          severity: "error",
          from: "src/core/domain/uses.ts",
          to: "src/adapters/forge/adapter.ts",
          via,
        },
      ]);
    },
  );

  it("rejects a core import that cannot be resolved, so a typo cannot hide an adapter import", async () => {
    const violations = await cruiseTree({
      "src/core/domain/typo.ts": `
        import { adapter } from "../../adapters/forge/adaptor.ts";
        export const used = adapter;
      `,
      "src/adapters/forge/adapter.ts": adapterSource,
    });

    expect(violations).toEqual([
      {
        rule: "not-to-unresolvable",
        severity: "error",
        from: "src/core/domain/typo.ts",
        to: "../../adapters/forge/adaptor.ts",
      },
    ]);
  });

  it.each(forgeSdkImports)(
    "rejects a core module with $kind of the forge SDK $name",
    async ({ name, source }) => {
      const violations = await cruiseTree({
        "src/core/ports/uses-sdk.ts": source,
        ...sdkPackage(name),
      });

      expect(violations).toEqual([
        {
          rule: "core-never-reaches-forge-sdk",
          severity: "error",
          from: "src/core/ports/uses-sdk.ts",
          to: `node_modules/${name}/index.js`,
          via: [`node_modules/${name}/index.js`],
        },
      ]);
    },
  );

  it("rejects a core module that reaches a forge SDK through a module outside the core", async () => {
    const violations = await cruiseTree({
      "src/core/domain/uses.ts": `
        import { client } from "../../app/github.ts";
        export const used = client;
      `,
      "src/app/github.ts": `
        import { sdk } from "@octokit/rest";
        export const client = sdk;
      `,
      ...sdkPackage("@octokit/rest"),
    });

    expect(violations).toEqual([
      {
        rule: "core-never-reaches-forge-sdk",
        severity: "error",
        from: "src/core/domain/uses.ts",
        to: "node_modules/@octokit/rest/index.js",
        via: ["src/app/github.ts", "node_modules/@octokit/rest/index.js"],
      },
    ]);
  });
});

const adapterSource = `
  export const adapter = { name: "example" };
  export type Adapter = typeof adapter;
`;

const coreImportsOfAnAdapter = [
  {
    name: "an import",
    source: `
      import { adapter } from "../../adapters/forge/adapter.ts";
      export const used = adapter;
    `,
  },
  {
    name: "a type-only import",
    source: `
      import type { Adapter } from "../../adapters/forge/adapter.ts";
      export type Used = Adapter;
    `,
  },
  {
    name: "a dynamic import",
    source: `
      export const load = () => import("../../adapters/forge/adapter.ts");
    `,
  },
  {
    name: "a re-export",
    source: `
      export { adapter } from "../../adapters/forge/adapter.ts";
    `,
  },
  {
    name: "an import written with a .js extension",
    source: `
      import { adapter } from "../../adapters/forge/adapter.js";
      export const used = adapter;
    `,
  },
];

const coreReachesAnAdapterThrough: {
  name: string;
  files: Record<string, string>;
  via: string[];
}[] = [
  {
    name: "a module outside the core",
    files: {
      "src/core/domain/uses.ts": `
        import { wired } from "../../app/wiring.ts";
        export const used = wired;
      `,
      "src/app/wiring.ts": `
        import { adapter } from "../adapters/forge/adapter.ts";
        export const wired = adapter;
      `,
    },
    via: ["src/app/wiring.ts", "src/adapters/forge/adapter.ts"],
  },
  {
    name: "the composition root",
    files: {
      "src/core/domain/uses.ts": `
        import { wired } from "../../main.ts";
        export const used = wired;
      `,
      "src/main.ts": `
        import { adapter } from "./adapters/forge/adapter.ts";
        export const wired = adapter;
      `,
    },
    via: ["src/main.ts", "src/adapters/forge/adapter.ts"],
  },
  {
    name: "a module under test",
    files: {
      "src/core/domain/uses.ts": `
        import { fake } from "../../../test/support/fake.ts";
        export const used = fake;
      `,
      "test/support/fake.ts": `
        import { adapter } from "../../src/adapters/forge/adapter.ts";
        export const fake = adapter;
      `,
    },
    via: ["test/support/fake.ts", "src/adapters/forge/adapter.ts"],
  },
  {
    name: "two modules in a row",
    files: {
      "src/core/domain/uses.ts": `
        import { first } from "../../app/first.ts";
        export const used = first;
      `,
      "src/app/first.ts": `
        import { second } from "./second.ts";
        export const first = second;
      `,
      "src/app/second.ts": `
        import { adapter } from "../adapters/forge/adapter.ts";
        export const second = adapter;
      `,
    },
    via: [
      "src/app/first.ts",
      "src/app/second.ts",
      "src/adapters/forge/adapter.ts",
    ],
  },
];

const forgeSdkImports = [
  {
    name: "@octokit/rest",
    kind: "an import",
    source: `import { sdk } from "@octokit/rest"; export const used = sdk;`,
  },
  {
    name: "@octokit/app",
    kind: "a type-only import",
    source: `import type { Sdk } from "@octokit/app"; export type Used = Sdk;`,
  },
  {
    name: "octokit",
    kind: "an import",
    source: `import { sdk } from "octokit"; export const used = sdk;`,
  },
  {
    name: "@gitbeaker/rest",
    kind: "an import",
    source: `import { sdk } from "@gitbeaker/rest"; export const used = sdk;`,
  },
  {
    name: "azure-devops-node-api",
    kind: "an import",
    source: `import { sdk } from "azure-devops-node-api"; export const used = sdk;`,
  },
];

// A stand-in package under node_modules, so the import resolves and the
// forge SDK rule, not the unresolvable rule, is what reports it.
function sdkPackage(name: string): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      main: "index.js",
    }),
    [`node_modules/${name}/index.js`]: `export const sdk = { name: "${name}" };`,
  };
}

interface Violation {
  rule: string;
  severity: string;
  from: string;
  to: string;
  via?: string[];
}

const configFile = fileURLToPath(
  new URL("../.dependency-cruiser.cjs", import.meta.url),
);
const trees: string[] = [];

afterEach(async () => {
  await Promise.all(
    trees.splice(0).map((tree) => rm(tree, { recursive: true, force: true })),
  );
});

async function cruiseTree(files: Record<string, string>): Promise<Violation[]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "forgecrew-deps-")));
  trees.push(root);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }

  const config = await extractDepcruiseConfig(configFile);
  const result = await cruise(["src"], {
    ...config.options,
    ruleSet: config,
    validate: true,
    baseDir: root,
  });
  if (typeof result.output === "string") {
    throw new Error("expected structured dependency-cruiser output");
  }

  return result.output.summary.violations.map((violation) => ({
    rule: violation.rule.name,
    severity: violation.rule.severity,
    from: violation.from,
    to: violation.to,
    via: violation.via?.map((hop) => hop.name),
  }));
}
