import { describe, expect, it } from "vitest";
import { FakeForge } from "../../src/adapters/forge/index.ts";
import type {
  Change,
  Finding,
  PassResult,
} from "../../src/core/domain/index.ts";
import type { DiscoveredChange, Forge } from "../../src/core/ports/index.ts";
import { localRepository } from "./git.ts";
import {
  aChange,
  type ForgeFactory,
  head,
  human,
  identity,
  otherLaneIdentity,
  ref,
  repository,
  world,
} from "./world.ts";

// The forge port's behaviour, which every forge adapter must show. Each
// adapter joins the list with a factory that builds it from a World;
// adapter-specific tests cover only the mapping details this suite cannot.

const forges: { name: string; create: ForgeFactory }[] = [
  {
    name: "fake",
    create: async (given) =>
      new FakeForge({
        identity: given.identity,
        cases: given.changes.map((change) => ({ change })),
      }),
  },
];

const anInstant = expect.stringMatching(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
);

describe.each(forges)("the $name forge", ({ create }) => {
  describe("discover", () => {
    it("lists every open change when given no starting point", async () => {
      const forge = await create(
        world({
          changes: [
            aChange({ ref: ref(1), updatedAt: "2026-01-01T00:00:00Z" }),
            aChange({ ref: ref(2), updatedAt: "2026-02-01T00:00:00Z" }),
            aChange({ ref: ref(3), state: "merged" }),
            aChange({ ref: ref(4), state: "closed" }),
          ],
        }),
      );

      expect(byNumber(await forge.discover(repository))).toEqual([
        { ref: ref(1), updatedAt: "2026-01-01T00:00:00Z" },
        { ref: ref(2), updatedAt: "2026-02-01T00:00:00Z" },
      ]);
    });

    it("lists the open changes updated at or after a point in time, and no earlier ones", async () => {
      const forge = await create(
        world({
          changes: [
            aChange({ ref: ref(1), updatedAt: "2026-01-01T00:00:00Z" }),
            aChange({ ref: ref(2), updatedAt: "2026-02-01T00:00:00Z" }),
            aChange({ ref: ref(3), updatedAt: "2026-03-01T00:00:00Z" }),
          ],
        }),
      );

      const discovered = await forge.discover(
        repository,
        "2026-02-01T00:00:00Z",
      );

      expect(byNumber(discovered)).toEqual([
        { ref: ref(2), updatedAt: "2026-02-01T00:00:00Z" },
        { ref: ref(3), updatedAt: "2026-03-01T00:00:00Z" },
      ]);
    });

    it("lists only the given repository's changes", async () => {
      const elsewhere = ref(1, "example-org/other-repo");
      const forge = await create(
        world({
          changes: [aChange({ ref: ref(1) }), aChange({ ref: elsewhere })],
        }),
      );

      expect(await forge.discover(elsewhere.repository)).toEqual([
        { ref: elsewhere, updatedAt: aChange().updatedAt },
      ]);
    });
  });

  describe("readChange", () => {
    it("reads a change as it is: verdicts, conversation, threads on lines, files and gone lines, and reviewers", async () => {
      const change = aChange({
        draft: false,
        ci: "pending",
        reviewers: [human],
        verdicts: [
          {
            id: "201",
            change: ref(),
            lane: "qa",
            head,
            author: otherLaneIdentity,
            summary: "Two findings.",
            claimedAt: "2026-01-02T03:00:00Z",
            result: "issues",
            closedAt: "2026-01-02T03:01:00Z",
          },
          {
            id: "202",
            change: ref(),
            lane: "review",
            head,
            author: identity,
            summary: "Reviewing.",
            claimedAt: "2026-01-02T03:02:00Z",
          },
        ],
        comments: [
          {
            id: "101",
            author: human,
            body: `@example-review-bot review ${head}`,
            createdAt: "2026-01-02T02:00:00Z",
          },
          {
            id: "102",
            author: otherLaneIdentity,
            body: "Starting.",
            createdAt: "2026-01-02T02:30:00Z",
          },
        ],
        threads: [
          {
            id: "301",
            path: "src/example.ts",
            anchor: "line",
            line: 12,
            comments: [
              {
                id: "301",
                author: otherLaneIdentity,
                body: "This can throw.",
                createdAt: "2026-01-02T03:01:00Z",
              },
              {
                id: "302",
                author: human,
                body: "Guarded in the next head.",
                createdAt: "2026-01-02T03:03:00Z",
              },
            ],
          },
          {
            id: "303",
            path: "src/example.ts",
            anchor: "file",
            comments: [
              {
                id: "303",
                author: otherLaneIdentity,
                body: "Split this file.",
                createdAt: "2026-01-02T03:04:00Z",
              },
            ],
          },
          {
            id: "304",
            path: "src/gone.ts",
            anchor: "line",
            comments: [
              {
                id: "304",
                author: otherLaneIdentity,
                body: "On a line a later head removed.",
                createdAt: "2026-01-02T03:05:00Z",
              },
            ],
          },
        ],
      });
      const forge = await create(world({ changes: [change] }));

      expect(await forge.readChange(change.ref)).toEqual(change);
    });

    it.each<Partial<Change>>([
      { state: "closed" },
      { state: "merged" },
      { draft: false },
      { fromFork: true },
      { ci: "none" },
      { ci: "pending" },
      { ci: "failure" },
      { files: [] },
      { files: [{ path: "assets/logo.png", lines: [] }] },
    ])("reads a change with %o", async (overrides) => {
      const change = aChange(overrides);
      const forge = await create(world({ changes: [change] }));

      expect(await forge.readChange(change.ref)).toEqual(change);
    });

    it.each<PassResult>([
      "accepted",
      "issues",
      "cancelled",
      "timed_out",
      "action_required",
    ])("reads a verdict record closed as %s", async (result) => {
      const change = aChange({
        verdicts: [
          {
            id: "201",
            change: ref(),
            lane: "review",
            head,
            author: identity,
            summary: "Done.",
            claimedAt: "2026-01-02T03:00:00Z",
            result,
            closedAt: "2026-01-02T03:10:00Z",
          },
        ],
      });
      const forge = await create(world({ changes: [change] }));

      expect(await forge.readChange(change.ref)).toEqual(change);
    });

    it("rejects a change that does not exist", async () => {
      const forge = await create(world({ changes: [aChange()] }));

      await expect(forge.readChange(ref(404))).rejects.toThrow();
    });
  });

  describe("claims and verdicts", () => {
    const target = { change: ref(), lane: "review", head };

    it("records a claim as an open verdict record on the head, by its own identity, outside CI", async () => {
      const forge = await create(
        world({ changes: [aChange({ ci: "success" })] }),
      );

      const claim = await forge.claim(target, "Queued for review.");

      expect(claim).toEqual({ id: expect.any(String), ...target });
      const read = await forge.readChange(ref());
      expect(read.verdicts).toEqual([
        {
          ...claim,
          author: identity,
          summary: "Queued for review.",
          claimedAt: anInstant,
        },
      ]);
      expect(read.ci).toBe("success");
    });

    it("updates an open claim's summary and keeps it open", async () => {
      const forge = await create(world({ changes: [aChange()] }));
      const claim = await forge.claim(target, "Queued for review.");

      await forge.updateClaim(claim, "Reviewing: 3 of 9 files.");

      const [record] = (await forge.readChange(ref())).verdicts;
      expect(record?.summary).toBe("Reviewing: 3 of 9 files.");
      expect(record?.result).toBeUndefined();
    });

    it.each<PassResult>([
      "accepted",
      "issues",
      "cancelled",
      "timed_out",
      "action_required",
    ])("closes a claim as %s", async (result) => {
      const forge = await create(world({ changes: [aChange()] }));
      const claim = await forge.claim(target, "Reviewing.");

      await forge.closeClaim(claim, result, "Finished.");

      expect((await forge.readChange(ref())).verdicts).toEqual([
        {
          ...claim,
          author: identity,
          summary: "Finished.",
          claimedAt: anInstant,
          result,
          closedAt: anInstant,
        },
      ]);
    });

    it("never changes a closed record", async () => {
      const forge = await create(world({ changes: [aChange()] }));
      const claim = await forge.claim(target, "Reviewing.");
      await forge.closeClaim(claim, "issues", "Two findings.");

      await expect(forge.updateClaim(claim, "Again.")).rejects.toThrow();
      await expect(
        forge.closeClaim(claim, "accepted", "Changed my mind."),
      ).rejects.toThrow();

      const [record] = (await forge.readChange(ref())).verdicts;
      expect(record).toMatchObject({
        result: "issues",
        summary: "Two findings.",
      });
    });

    it("closes an open claim found in a read, such as an orphan", async () => {
      const forge = await create(
        world({
          changes: [
            aChange({
              verdicts: [
                {
                  id: "201",
                  change: ref(),
                  lane: "review",
                  head,
                  author: identity,
                  summary: "Reviewing.",
                  claimedAt: "2026-01-02T03:00:00Z",
                },
              ],
            }),
          ],
        }),
      );
      const [orphan] = (await forge.readChange(ref())).verdicts;
      if (orphan === undefined) throw new Error("expected the orphan claim");

      await forge.closeClaim(orphan, "cancelled", "The pass died.");

      expect((await forge.readChange(ref())).verdicts).toEqual([
        {
          ...orphan,
          summary: "The pass died.",
          result: "cancelled",
          closedAt: anInstant,
        },
      ]);
    });

    it("refuses to update or close a record another identity opened", async () => {
      const foreign = {
        id: "201",
        change: ref(),
        lane: "qa",
        head,
        author: otherLaneIdentity,
        summary: "Testing.",
        claimedAt: "2026-01-02T03:00:00Z",
      };
      const forge = await create(
        world({ changes: [aChange({ verdicts: [foreign] })] }),
      );

      await expect(forge.updateClaim(foreign, "Mine now.")).rejects.toThrow();
      await expect(
        forge.closeClaim(foreign, "accepted", "Accepted."),
      ).rejects.toThrow();

      expect((await forge.readChange(ref())).verdicts).toEqual([foreign]);
    });

    it("keeps every attempt on a head, oldest first, so retries can be counted", async () => {
      const forge = await create(world({ changes: [aChange()] }));
      const first = await forge.claim(target, "Attempt 1.");
      await forge.closeClaim(first, "cancelled", "Crashed.");
      const second = await forge.claim(target, "Attempt 2.");

      const { verdicts } = await forge.readChange(ref());

      expect(verdicts.map(({ id, result }) => ({ id, result }))).toEqual([
        { id: first.id, result: "cancelled" },
        { id: second.id, result: undefined },
      ]);
    });
  });

  describe("postFindings", () => {
    it("opens one review thread per finding on its line, by its own identity, after the existing ones", async () => {
      const existing = {
        id: "301",
        path: "README.md",
        anchor: "line" as const,
        line: 1,
        comments: [
          {
            id: "301",
            author: human,
            body: "Typo.",
            createdAt: "2026-01-02T03:00:00Z",
          },
        ],
      };
      const forge = await create(
        world({ changes: [aChange({ threads: [existing] })] }),
      );

      await forge.postFindings(ref(), head, [
        { path: "src/a.ts", line: 3, body: "This can throw." },
        { path: "src/b.ts", line: 30, body: "Unused import." },
      ]);

      expect((await forge.readChange(ref())).threads).toEqual([
        existing,
        {
          id: expect.any(String),
          path: "src/a.ts",
          anchor: "line",
          line: 3,
          comments: [
            {
              id: expect.any(String),
              author: identity,
              body: "This can throw.",
              createdAt: anInstant,
            },
          ],
        },
        {
          id: expect.any(String),
          path: "src/b.ts",
          anchor: "line",
          line: 30,
          comments: [
            {
              id: expect.any(String),
              author: identity,
              body: "Unused import.",
              createdAt: anInstant,
            },
          ],
        },
      ]);
    });

    it("opens a thread on the whole file for a finding without a line", async () => {
      const forge = await create(world({ changes: [aChange()] }));

      await forge.postFindings(ref(), head, [
        { path: "src/b.ts", body: "Split this file." },
      ]);

      expect((await forge.readChange(ref())).threads).toEqual([
        {
          id: expect.any(String),
          path: "src/b.ts",
          anchor: "file",
          comments: [
            {
              id: expect.any(String),
              author: identity,
              body: "Split this file.",
              createdAt: anInstant,
            },
          ],
        },
      ]);
    });

    it.each<{ name: string; finding: Finding }>([
      {
        name: "a line the diff does not show",
        finding: { path: "src/a.ts", line: 11, body: "Off the diff." },
      },
      {
        name: "a line between two ranges the diff shows",
        finding: { path: "src/b.ts", line: 20, body: "Between hunks." },
      },
      {
        name: "a file the change does not touch",
        finding: { path: "src/c.ts", line: 1, body: "Elsewhere." },
      },
      {
        name: "the whole of a file the change does not touch",
        finding: { path: "src/c.ts", body: "Elsewhere." },
      },
    ])(
      "rejects a finding on $name and posts none of the call's findings",
      async ({ finding }) => {
        const forge = await create(world({ changes: [aChange()] }));

        await expect(
          forge.postFindings(ref(), head, [
            { path: "src/a.ts", line: 3, body: "On the diff." },
            finding,
          ]),
        ).rejects.toThrow();

        expect((await forge.readChange(ref())).threads).toEqual([]);
      },
    );

    it("does nothing when there are no findings, leaving updatedAt as it was", async () => {
      const forge = await create(world({ changes: [aChange()] }));
      const before = wholeSecondNow();

      await forge.postFindings(ref(), head, []);

      const read = await forge.readChange(ref());
      expect(read.threads).toEqual([]);
      expect(read.updatedAt).toBe(aChange().updatedAt);
      expect(await forge.discover(repository, before)).toEqual([]);
    });

    it("does nothing when there are no findings, even for a change that does not exist", async () => {
      const forge = await create(world({ changes: [aChange()] }));

      await expect(
        forge.postFindings(ref(404), head, []),
      ).resolves.toBeUndefined();
    });
  });

  describe("publish", () => {
    const branch = aChange().branch;

    it("moves the change to the new head", async () => {
      const local = await localRepository(branch);
      const forge = await create(
        world({
          changes: [aChange({ head: local.base })],
          remotes: { [repository]: local.path },
        }),
      );

      const outcome = await forge.publish(ref(), {
        source: local.path,
        head: local.next,
        expectedHead: local.base,
      });

      expect(outcome).toBe("published");
      expect((await forge.readChange(ref())).head).toBe(local.next);
    });

    it("refuses as stale when the change's head is not the expected one", async () => {
      const local = await localRepository(branch);
      const forge = await create(
        world({
          changes: [aChange({ head: local.base })],
          remotes: { [repository]: local.path },
        }),
      );

      const outcome = await forge.publish(ref(), {
        source: local.path,
        head: local.next,
        expectedHead: "badc0de".padEnd(40, "0"),
      });

      expect(outcome).toBe("stale-head");
      expect((await forge.readChange(ref())).head).toBe(local.base);
    });

    it("moves updatedAt, so discovery finds the change again", async () => {
      const local = await localRepository(branch);
      const forge = await create(
        world({
          changes: [aChange({ head: local.base })],
          remotes: { [repository]: local.path },
        }),
      );
      const before = wholeSecondNow();

      await forge.publish(ref(), {
        source: local.path,
        head: local.next,
        expectedHead: local.base,
      });

      expect(await forge.discover(repository, before)).toEqual([
        { ref: ref(), updatedAt: anInstant },
      ]);
    });

    it("refuses to publish to a change from a fork", async () => {
      const local = await localRepository(branch);
      const forge = await create(
        world({ changes: [aChange({ head: local.base, fromFork: true })] }),
      );

      await expect(
        forge.publish(ref(), {
          source: local.path,
          head: local.next,
          expectedHead: local.base,
        }),
      ).rejects.toThrow();
    });

    it("leaves the new head with no verdict records", async () => {
      const local = await localRepository(branch);
      const forge = await create(
        world({
          changes: [aChange({ head: local.base })],
          remotes: { [repository]: local.path },
        }),
      );
      const claim = await forge.claim(
        { change: ref(), lane: "review", head: local.base },
        "Reviewing.",
      );
      await forge.closeClaim(claim, "accepted", "Accepted.");

      await forge.publish(ref(), {
        source: local.path,
        head: local.next,
        expectedHead: local.base,
      });

      expect((await forge.readChange(ref())).verdicts).toEqual([]);
    });
  });

  describe("updatedAt", () => {
    it.each<{ name: string; write: (forge: Forge) => Promise<unknown> }>([
      {
        name: "opening review threads",
        write: (forge) =>
          forge.postFindings(ref(), head, [
            { path: "src/a.ts", line: 3, body: "This can throw." },
          ]),
      },
      {
        name: "handing the change off",
        write: (forge) =>
          forge.markReady(ref(), { reviewer: human, comment: "Ready." }),
      },
    ])(
      "moves on $name, so discovery finds the change again",
      async ({ write }) => {
        const forge = await create(world({ changes: [aChange()] }));
        const before = wholeSecondNow();

        await write(forge);

        expect(await forge.discover(repository, before)).toEqual([
          { ref: ref(), updatedAt: anInstant },
        ]);
      },
    );

    it("stays when a lane claims and closes a record, which belongs to the commit", async () => {
      const forge = await create(world({ changes: [aChange()] }));
      const before = wholeSecondNow();

      const claim = await forge.claim(
        { change: ref(), lane: "review", head },
        "Reviewing.",
      );
      await forge.closeClaim(claim, "accepted", "Accepted.");

      expect((await forge.readChange(ref())).updatedAt).toBe(
        aChange().updatedAt,
      );
      expect(await forge.discover(repository, before)).toEqual([]);
    });
  });

  describe("markReady", () => {
    it("marks the change ready, requests the reviewer's review and posts the handoff comment", async () => {
      const forge = await create(
        world({ changes: [aChange({ draft: true, reviewers: [] })] }),
      );

      await forge.markReady(ref(), {
        reviewer: human,
        comment: "Ready for your review.",
      });

      const read = await forge.readChange(ref());
      expect(read.draft).toBe(false);
      expect(read.reviewers).toEqual([human]);
      expect(read.comments).toEqual([
        {
          id: expect.any(String),
          author: identity,
          body: "Ready for your review.",
          createdAt: anInstant,
        },
      ]);
    });
  });

  describe("merge", () => {
    it("merges the change at its head", async () => {
      const forge = await create(
        world({ changes: [aChange({ draft: false })] }),
      );

      expect(await forge.merge(ref(), head)).toBe("merged");
      expect((await forge.readChange(ref())).state).toBe("merged");
    });

    it("refuses as stale when the head moved", async () => {
      const forge = await create(
        world({ changes: [aChange({ draft: false })] }),
      );

      const outcome = await forge.merge(ref(), "badc0de".padEnd(40, "0"));

      expect(outcome).toBe("stale-head");
      expect((await forge.readChange(ref())).state).toBe("open");
    });

    it("reports a merge the forge refuses as blocked", async () => {
      // Every forge refuses to merge a draft.
      const forge = await create(
        world({ changes: [aChange({ draft: true })] }),
      );

      expect(await forge.merge(ref(), head)).toBe("blocked");
      expect((await forge.readChange(ref())).state).toBe("open");
    });
  });
});

// GitHub's timestamps have whole seconds, so a write in this second can carry
// a time earlier than now.
function wholeSecondNow(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
}

function byNumber(changes: DiscoveredChange[]): DiscoveredChange[] {
  return changes.toSorted((a, b) => a.ref.number - b.ref.number);
}
