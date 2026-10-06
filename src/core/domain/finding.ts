import type { ChangedFile } from "./change.ts";

/**
 * A lane's finding. It opens a review thread on its line, or on its whole
 * file when it has none, and only where the change's diff on the head shows
 * that line or file.
 */
export interface Finding {
  readonly path: string;
  /** The line in the head's version of the file; absent for the whole file. */
  readonly line?: number;
  /**
   * The text the thread opens with. The dispatcher renders it from the pass's
   * response, severity included, because no forge has a field for severity.
   * A finding the diff does not show goes elsewhere, such as the verdict's
   * summary.
   */
  readonly body: string;
}

/**
 * Whether the change's diff shows where a finding sits: its line, or its
 * file when it has no line. Only such a finding can open a review thread.
 */
export function isOnTheDiff(
  { path, line }: Finding,
  files: readonly ChangedFile[],
): boolean {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) return false;
  return (
    line === undefined ||
    file.lines.some(({ start, end }) => start <= line && line <= end)
  );
}
