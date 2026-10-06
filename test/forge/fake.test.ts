import { describe, expect, it } from "vitest";
import { FakeForge } from "../../src/adapters/forge/index.ts";
import { aChange, head, human, identity, ref } from "./world.ts";

// The contract suite covers the fake's behaviour as a forge. These tests cover
// what only the fake promises.

describe("the fake forge", () => {
  it("leaves the recorded cases it was given untouched", async () => {
    const cases = [{ change: aChange() }];
    const recorded = structuredClone(cases);
    const forge = new FakeForge({ identity, cases });

    const claim = await forge.claim(
      { change: ref(), lane: "review", head },
      "Reviewing.",
    );
    await forge.closeClaim(claim, "accepted", "Accepted.");
    await forge.markReady(ref(), { reviewer: human, comment: "Ready." });

    expect(cases).toEqual(recorded);
  });

  it("stamps its writes with its clock, so discovery sees changes it updated", async () => {
    const now = "2026-05-06T07:08:09Z";
    const forge = new FakeForge({
      identity,
      cases: [{ change: aChange() }],
      now: () => now,
    });

    await forge.claim({ change: ref(), lane: "review", head }, "Reviewing.");
    await forge.markReady(ref(), { reviewer: human, comment: "Ready." });

    const { verdicts, updatedAt } = await forge.readChange(ref());
    expect(verdicts[0]?.claimedAt).toBe(now);
    expect(updatedAt).toBe(now);
    expect(await forge.discover(ref().repository, now)).toEqual([
      { ref: ref(), updatedAt: now },
    ]);
  });
});
