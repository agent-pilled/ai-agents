import type {
  Change,
  ChangeRef,
  Identity,
  Lane,
} from "../../src/core/domain/index.ts";
import type { Forge } from "../../src/core/ports/index.ts";

/**
 * The forge state a contract test starts from, in domain terms. Each
 * adapter's harness turns it into its forge's own state. Ids are numeric
 * strings, which every supported forge can hold.
 */
export interface World {
  /** The identity the forge under test acts as. */
  readonly identity: Identity;
  /** The instance's lanes. */
  readonly lanes: readonly Lane[];
  readonly changes: readonly Change[];
  /**
   * Local repositories whose branches each forge-side repository starts
   * with, by repository path. Only tests that publish need one.
   */
  readonly remotes?: Readonly<Record<string, string>>;
}

export type ForgeFactory = (world: World) => Promise<Forge>;

// Obviously fictional names, so nothing reads as a real deployment. An
// identity is a forge handle; the bots' use GitHub's form for an App's
// account, which the fake treats like any other string.
export const identity = "example-review-bot[bot]";
export const otherLaneIdentity = "example-qa-bot[bot]";
export const human = "jane-doe";
export const repository = "example-org/example-repo";
export const head = "c0ffee".padEnd(40, "0");

export function world(overrides: Partial<World> = {}): World {
  return { identity, lanes: ["review", "qa"], changes: [], ...overrides };
}

export function ref(number = 7, inRepository = repository): ChangeRef {
  return { repository: inRepository, number };
}

export function aChange(overrides: Partial<Change> = {}): Change {
  return {
    ref: ref(),
    state: "open",
    draft: true,
    author: human,
    branch: "feature/example",
    fromFork: false,
    head,
    updatedAt: "2026-01-02T03:04:05Z",
    files: [
      { path: "src/a.ts", lines: [{ start: 1, end: 10 }] },
      {
        path: "src/b.ts",
        lines: [
          { start: 5, end: 12 },
          { start: 30, end: 31 },
        ],
      },
    ],
    ci: "success",
    verdicts: [],
    comments: [],
    threads: [],
    reviewers: [],
    ...overrides,
  };
}
