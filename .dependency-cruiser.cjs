/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-never-reaches-adapter",
      comment:
        "The core depends on ports only. Adapters implement the ports and are " +
        "selected by configuration where the application is assembled " +
        "(docs/adr/0005-in-tree-ports-and-adapters.md). The rule follows " +
        "imports to any depth, so the core cannot reach an adapter through " +
        "the composition root or any other module either. It sees literal " +
        "import specifiers only; no static check can see a computed one.",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/adapters/", reachable: true },
    },
    {
      name: "core-never-reaches-forge-sdk",
      comment:
        "The core reaches a forge only through the forge port. Forge SDKs " +
        "such as Octokit belong to the forge adapters, so the port cannot " +
        "quietly take on one forge's API. Like the rule above, it follows " +
        "imports to any depth.",
      severity: "error",
      from: { path: "^src/core/" },
      to: {
        path: "(^|/)node_modules/(@octokit/|octokit/|@gitbeaker/|azure-devops-node-api/)",
        reachable: true,
      },
    },
    {
      name: "not-to-unresolvable",
      comment:
        "An import the cruiser cannot resolve could point at an adapter, so " +
        "the rule above could not see it.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    // Count type-only imports too: a type dependency still points the wrong way.
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
