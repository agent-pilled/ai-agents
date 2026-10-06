import type { Change } from "./change.ts";

/**
 * What one pass saw, kept so that another configuration can replay the same
 * input. This is the minimum the fake forge serves: the dispatcher's read of
 * the change. The repository cuts at that moment join it with the broker.
 */
export interface RecordedCase {
  readonly change: Change;
}
