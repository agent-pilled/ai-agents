// A change as a dispatcher reads it from the forge: a pull request on GitHub
// and Azure DevOps, a merge request on GitLab.

export interface Change {
  readonly ref: ChangeRef;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly author: Identity;
  /** The branch the change merges from. */
  readonly branch: string;
  /** Whether that branch lives in a fork. Forgecrew never processes those automatically. */
  readonly fromFork: boolean;
  /** The commit the change points at now. */
  readonly head: Sha;
  /**
   * When the change itself last moved: its head, state, draft, reviewers,
   * conversation or threads. CI and verdict records belong to the head's
   * commit and do not move it.
   */
  readonly updatedAt: Instant;
  /** The files the change's diff touches, in the forge's order. */
  readonly files: readonly ChangedFile[];
  /** CI on the head, combined. Lane verdict records never count as CI. */
  readonly ci: CiState;
  /** Every lane's claims and verdict records on the head, oldest first. Records on earlier heads are not listed. */
  readonly verdicts: readonly VerdictRecord[];
  /** The change's conversation, oldest first. */
  readonly comments: readonly Comment[];
  /** Review threads on lines or whole files of the change, oldest first. */
  readonly threads: readonly Thread[];
  /** The identities whose review is requested and not yet given. */
  readonly reviewers: readonly Identity[];
}

export interface ChangeRef {
  /** The repository's path on its forge, such as `owner/name`. */
  readonly repository: string;
  readonly number: number;
}

export type CiState = "none" | "pending" | "success" | "failure";

/** A file as the change's diff on its head shows it. */
export interface ChangedFile {
  readonly path: string;
  /**
   * The head's lines the diff shows, where a finding can sit. Empty when the
   * forge shows none, as for a deleted, binary or very large file.
   */
  readonly lines: readonly LineRange[];
}

/** Lines `start` to `end` of a file, both included. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * A lane's record on one head. It starts as a claim while the lane's pass
 * runs, and closes with the verdict or the operational outcome. Once closed it
 * never changes; another pass writes another record.
 */
export interface VerdictRecord extends Claim {
  readonly author: Identity;
  /** What the record says on the forge: progress while open, then the result. */
  readonly summary: string;
  readonly claimedAt: Instant;
  /** Absent while the claim is open. */
  readonly result?: PassResult;
  readonly closedAt?: Instant;
}

/**
 * The in-progress record a dispatcher writes on the captured head before a
 * pass starts. It shows who is working; it is not a lock.
 */
export interface Claim {
  readonly id: string;
  readonly change: ChangeRef;
  readonly lane: Lane;
  readonly head: Sha;
}

/** How a claim closes: a verdict, or an operational outcome. */
export type PassResult = Verdict | OperationalOutcome;

/** A lane's outcome. Findings live in review threads, not in the verdict. */
export type Verdict = "accepted" | "issues";

/** How a pass ended when it produced no verdict. It never reads as a verdict. */
export type OperationalOutcome = "cancelled" | "timed_out" | "action_required";

/** A lane's name, such as `review`. Each served repository configures its lanes. */
export type Lane = string;

export interface Comment {
  readonly id: string;
  readonly author: Identity;
  /**
   * The text as written. A mention appears as `@` and the name the identity
   * is mentioned by, whatever markup the forge stores.
   */
  readonly body: string;
  readonly createdAt: Instant;
}

export interface Thread {
  readonly id: string;
  readonly path: string;
  /**
   * What the thread sits on: a line, or the whole file. A thread on a range
   * of lines reads as its last line.
   */
  readonly anchor: "line" | "file";
  /**
   * For a thread on a line, that line in the head's version of the file;
   * absent when the head's version has no such line, because it is gone
   * since or the thread sits on a line the change deletes.
   */
  readonly line?: number;
  readonly comments: readonly Comment[];
}

/**
 * A forge identity's handle: the account's login as the forge reports it, a
 * person's or a bot account's (on GitHub an App's is `<slug>[bot]`). Equal
 * handles are the same identity, so a person and an App that share a name
 * stay apart.
 */
export type Identity = string;

/** A full commit SHA. */
export type Sha = string;

/** An ISO 8601 timestamp in UTC. */
export type Instant = string;
