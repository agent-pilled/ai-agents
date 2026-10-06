import type {
  Change,
  ChangeRef,
  Claim,
  Finding,
  Identity,
  Instant,
  Lane,
  PassResult,
  Sha,
} from "../domain/index.ts";

/**
 * Everything the scheduler and the dispatchers read from a forge and write to
 * it, in domain terms. An adapter acts as one forge identity, its role's: every
 * record, thread and comment it writes is attributed to that identity.
 *
 * Operations reject when the forge fails or the change does not exist. Refusals
 * the dispatcher expects in normal work, such as a head that moved, are
 * outcomes instead.
 */
export interface Forge {
  /**
   * The open changes in a repository updated at or after `since`, or every
   * open change without it. Polling with the latest `updatedAt` seen may
   * return a change again; the caller rereads it anyway. CI and verdict
   * records do not move `updatedAt`, so a caller waiting on them rereads the
   * change instead of waiting to discover it.
   */
  discover(repository: string, since?: Instant): Promise<DiscoveredChange[]>;

  /** Reads a change as it is now, resolving its head at that moment. */
  readChange(change: ChangeRef): Promise<Change>;

  /** Records a claim: an open verdict record for the lane on the given head. */
  claim(target: ClaimTarget, summary: string): Promise<Claim>;

  /** Replaces an open claim's summary, which shows the pass's progress. */
  updateClaim(claim: Claim, summary: string): Promise<void>;

  /**
   * Closes an open claim with a verdict or an operational outcome. Rejects if
   * the claim is already closed, because a closed record never changes.
   */
  closeClaim(claim: Claim, result: PassResult, summary: string): Promise<void>;

  /**
   * Opens one review thread per finding, on the given head. Rejects without
   * posting any if one does not sit on the change's diff (`Change.files`). A
   * forge failure part-way leaves the threads before it in place; a read
   * shows which. With no findings it does nothing, not even check that the
   * change exists.
   */
  postFindings(
    change: ChangeRef,
    head: Sha,
    findings: readonly Finding[],
  ): Promise<void>;

  /**
   * Moves the change's branch to a commit made locally, unless the change's
   * head is no longer the one the commit was made on.
   */
  publish(change: ChangeRef, commits: Commits): Promise<PublishOutcome>;

  /**
   * Hands the change off: marks it ready, requests the reviewer's review and
   * posts the handoff comment.
   */
  markReady(change: ChangeRef, handoff: Handoff): Promise<void>;

  /**
   * Merges the change if its head is still the given one and the forge allows
   * the merge, then deletes its branch.
   */
  merge(change: ChangeRef, head: Sha): Promise<MergeOutcome>;
}

export interface DiscoveredChange {
  readonly ref: ChangeRef;
  readonly updatedAt: Instant;
}

export interface ClaimTarget {
  readonly change: ChangeRef;
  readonly lane: Lane;
  readonly head: Sha;
}

export interface Commits {
  /** A local Git repository that holds the commits. */
  readonly source: string;
  /** The commit to publish as the change's new head. */
  readonly head: Sha;
  /** The change's head the commits were made on. */
  readonly expectedHead: Sha;
}

/** `stale-head`: the change's head moved since the commits were made. */
export type PublishOutcome = "published" | "stale-head";

export interface Handoff {
  /** The Accountable person. */
  readonly reviewer: Identity;
  readonly comment: string;
}

/**
 * `blocked`: the forge refused the merge, for example because a required
 * verdict or approval is missing. `stale-head`: the change's head moved.
 */
export type MergeOutcome = "merged" | "blocked" | "stale-head";
