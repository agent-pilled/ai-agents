import {
  type Change,
  type ChangeRef,
  type Claim,
  type Comment,
  type Finding,
  type Identity,
  type Instant,
  isOnTheDiff,
  type PassResult,
  type RecordedCase,
  type Sha,
  type VerdictRecord,
} from "../../core/domain/index.ts";
import type {
  ClaimTarget,
  Commits,
  DiscoveredChange,
  Forge,
  Handoff,
  MergeOutcome,
  PublishOutcome,
} from "../../core/ports/index.ts";

export interface FakeForgeOptions {
  /** The identity every write is attributed to. */
  readonly identity: Identity;
  /** The changes it starts from, one recorded case each. */
  readonly cases: readonly RecordedCase[];
  /** The clock for timestamps on writes; the current time by default. */
  readonly now?: () => Instant;
}

/**
 * A forge adapter that serves recorded cases from memory. Writes change only
 * its own copy, so a caller can read them back, and nothing leaves the
 * process. The cases it was given stay untouched.
 */
export class FakeForge implements Forge {
  readonly #identity: Identity;
  readonly #now: () => Instant;
  readonly #states = new Map<string, State>();
  readonly #usedIds = new Set<string>();
  #lastId = 0;

  constructor({ identity, cases, now = currentTime }: FakeForgeOptions) {
    this.#identity = identity;
    this.#now = now;
    for (const { change } of structuredClone(cases)) {
      const { verdicts, ...rest } = change;
      this.#states.set(key(change.ref), {
        change: rest,
        records: [...verdicts],
      });
      for (const id of idsIn(change)) this.#usedIds.add(id);
    }
  }

  async discover(
    repository: string,
    since?: Instant,
  ): Promise<DiscoveredChange[]> {
    return [...this.#states.values()]
      .map(({ change }) => change)
      .filter(
        ({ ref, state, updatedAt }) =>
          ref.repository === repository &&
          state === "open" &&
          (since === undefined || Date.parse(updatedAt) >= Date.parse(since)),
      )
      .map(({ ref, updatedAt }) => ({ ref, updatedAt }));
  }

  async readChange(ref: ChangeRef): Promise<Change> {
    const { change, records } = this.#state(ref);
    return structuredClone({
      ...change,
      verdicts: records.filter((record) => record.head === change.head),
    });
  }

  async claim(target: ClaimTarget, summary: string): Promise<Claim> {
    const claim = { id: this.#nextId(), ...target };
    this.#state(target.change).records.push({
      ...claim,
      author: this.#identity,
      summary,
      claimedAt: this.#now(),
    });
    return structuredClone(claim);
  }

  async updateClaim(claim: Claim, summary: string): Promise<void> {
    this.#replaceOpenRecord(claim, (record) => ({ ...record, summary }));
  }

  async closeClaim(
    claim: Claim,
    result: PassResult,
    summary: string,
  ): Promise<void> {
    this.#replaceOpenRecord(claim, (record) => ({
      ...record,
      summary,
      result,
      closedAt: this.#now(),
    }));
  }

  async postFindings(
    ref: ChangeRef,
    _head: Sha,
    findings: readonly Finding[],
  ): Promise<void> {
    if (findings.length === 0) return;
    const state = this.#state(ref);
    const offTheDiff = findings.find(
      (finding) => !isOnTheDiff(finding, state.change.files),
    );
    if (offTheDiff !== undefined) {
      throw new Error(`${location(offTheDiff)} is not on ${label(ref)}'s diff`);
    }
    const threads = findings.map(({ path, line, body }) => ({
      id: this.#nextId(),
      path,
      ...(line === undefined
        ? { anchor: "file" as const }
        : { anchor: "line" as const, line }),
      comments: [this.#comment(body)],
    }));
    this.#update(state, { threads: [...state.change.threads, ...threads] });
  }

  async publish(ref: ChangeRef, commits: Commits): Promise<PublishOutcome> {
    const state = this.#state(ref);
    if (state.change.fromFork) {
      throw new Error(`${label(ref)} comes from a fork`);
    }
    if (state.change.head !== commits.expectedHead) return "stale-head";
    this.#update(state, { head: commits.head });
    return "published";
  }

  async markReady(
    ref: ChangeRef,
    { reviewer, comment }: Handoff,
  ): Promise<void> {
    const state = this.#state(ref);
    const { reviewers, comments } = state.change;
    this.#update(state, {
      draft: false,
      reviewers: reviewers.includes(reviewer)
        ? reviewers
        : [...reviewers, reviewer],
      comments: [...comments, this.#comment(comment)],
    });
  }

  async merge(ref: ChangeRef, head: Sha): Promise<MergeOutcome> {
    const state = this.#state(ref);
    if (state.change.state !== "open" || state.change.draft) return "blocked";
    if (state.change.head !== head) return "stale-head";
    this.#update(state, { state: "merged" });
    return "merged";
  }

  #state(ref: ChangeRef): State {
    const state = this.#states.get(key(ref));
    if (state === undefined) throw new Error(`${label(ref)} does not exist`);
    return state;
  }

  #update(state: State, changes: Partial<State["change"]>): void {
    state.change = { ...state.change, ...changes, updatedAt: this.#now() };
  }

  #replaceOpenRecord(
    claim: Claim,
    replace: (record: VerdictRecord) => VerdictRecord,
  ): void {
    const { records } = this.#state(claim.change);
    const index = records.findIndex((record) => record.id === claim.id);
    const record = records[index];
    if (record === undefined) throw new Error(`claim ${claim.id} not found`);
    if (record.author !== this.#identity) {
      throw new Error(`claim ${claim.id} belongs to ${record.author}`);
    }
    if (record.result !== undefined) {
      throw new Error(`claim ${claim.id} is already closed`);
    }
    records[index] = replace(record);
  }

  #comment(body: string): Comment {
    return {
      id: this.#nextId(),
      author: this.#identity,
      body,
      createdAt: this.#now(),
    };
  }

  // Numeric, like every supported forge's ids, and never one a case uses.
  #nextId(): string {
    let id: string;
    do id = String(++this.#lastId);
    while (this.#usedIds.has(id));
    this.#usedIds.add(id);
    return id;
  }
}

interface State {
  change: Omit<Change, "verdicts">;
  readonly records: VerdictRecord[];
}

function key({ repository, number }: ChangeRef): string {
  return `${repository}#${number}`;
}

function label(ref: ChangeRef): string {
  return `change ${key(ref)}`;
}

function location({ path, line }: Finding): string {
  return line === undefined ? path : `${path}:${line}`;
}

function idsIn({ verdicts, comments, threads }: Change): string[] {
  return [
    ...verdicts.map(({ id }) => id),
    ...comments.map(({ id }) => id),
    ...threads.flatMap(({ id, comments }) => [
      id,
      ...comments.map((c) => c.id),
    ]),
  ];
}

function currentTime(): Instant {
  return new Date().toISOString();
}
