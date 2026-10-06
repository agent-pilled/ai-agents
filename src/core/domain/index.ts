// The domain model, in the terms of CONTEXT.md. It depends on nothing outside
// the core.
export type {
  Change,
  ChangedFile,
  ChangeRef,
  CiState,
  Claim,
  Comment,
  Identity,
  Instant,
  Lane,
  LineRange,
  OperationalOutcome,
  PassResult,
  Sha,
  Thread,
  Verdict,
  VerdictRecord,
} from "./change.ts";
export { type Finding, isOnTheDiff } from "./finding.ts";
export type { RecordedCase } from "./recorded-case.ts";
