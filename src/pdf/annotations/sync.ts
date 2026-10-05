/**
 * One PDF's marks, kept in step between every tab that has it open.
 *
 * Each editor used to write its whole list of marks on every change. Two tabs on the same PDF
 * then took turns erasing each other: tab A's edit to the first note, then tab B's to the second
 * — saved with B's copy of the first note, from before A changed it. Nothing was written at the
 * same moment; each tab simply wrote what it had seen.
 *
 * So an editor never writes its list. It writes *its own changes* — what differs from the marks
 * it last saw stored (its baseline) — on top of whatever is stored now, under the document's lock,
 * and other tabs' changes are folded into the open editors as they arrive (`reconcileMarks`).
 *
 * The rules, per mark:
 * - changed here, untouched there: ours;
 * - changed in both since the baseline: the later `updated` wins;
 * - deleted here, untouched there: deleted;
 * - deleted here, but edited there afterwards: kept — a deletion never silently takes someone's
 *   later work with it;
 * - added anywhere: kept.
 */
import { storage } from 'wxt/utils/storage';
import { withStorageLock } from '@/shared/storage-lock';
import { normalizeStoredMarks } from '@/shared/record-shapes';
import type { Mark } from './model';
import { loadMarks, saveMarks } from './store';

/**
 * Marks as text, field order aside: a mark that went through storage (and `normalizeStoredMarks`)
 * must compare equal to the same mark in the editor, or a tab's own write looks like news.
 */
function canon(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
const same = (a: Mark, b: Mark): boolean => canon(a) === canon(b);

/** `current`'s changes since `baseline`, applied on top of `latest`. */
export function reconcileMarks(latest: readonly Mark[], baseline: readonly Mark[], current: readonly Mark[]): Mark[] {
  const result = new Map(latest.map((m) => [m.id, m]));
  const base = new Map(baseline.map((m) => [m.id, m]));
  const mine = new Map(current.map((m) => [m.id, m]));

  for (const [id, before] of base) {
    if (mine.has(id)) continue;
    // Deleted here. Gone there too, or unchanged there since: delete. Edited there since: keep.
    const theirs = result.get(id);
    if (theirs && (theirs.updated ?? 0) <= (before.updated ?? 0)) result.delete(id);
  }
  for (const mark of current) {
    const before = base.get(mark.id);
    if (before && same(before, mark)) continue; // not changed here: whatever is stored stands
    const theirs = result.get(mark.id);
    const changedThere = before ? theirs != null && !same(theirs, before) : theirs != null;
    if (!changedThere || (mark.updated ?? 0) >= (theirs?.updated ?? 0)) result.set(mark.id, mark);
  }
  return [...result.values()];
}

/**
 * Apply `current`'s changes since `baseline` to what is stored for `hash`, under its lock; returns
 * what is stored now. `onMerged` sees the result before it is written.
 *
 * Shared by the editors and the background — which finishes an editor's last change when its tab
 * closes before the write could (see `MarkSync.handoff`).
 */
export async function persistChanges(
  hash: string,
  name: string,
  baseline: readonly Mark[] | (() => readonly Mark[]),
  current: readonly Mark[] | (() => readonly Mark[]),
  onMerged?: (merged: Mark[]) => void,
  onWritten?: (written: { mine: readonly Mark[]; merged: Mark[] }) => void,
): Promise<Mark[]> {
  return withStorageLock(`pdfMarks:${hash}`, async () => {
    // Both read *now*, inside the lock, and together: a write queued behind another from the same
    // editor must compare the editor as it is against what that one stored. (An Undo queued
    // behind its edit compared against the old baseline, looked like no change, and the undone
    // edit was what stayed stored.) Marks captured at queueing time would not match a baseline
    // moved on by another tab since — and that tab's change would look like this one's deletion.
    const base = typeof baseline === 'function' ? baseline() : baseline;
    const now = typeof current === 'function' ? current() : current;
    const stored = await loadMarks(hash).catch(() => null);
    const merged = reconcileMarks(stored ? (stored.marks as Mark[]) : base, base, now);
    onMerged?.(merged);
    await saveMarks(hash, name, merged);
    // Only now, with the write done and the lock still held, does the writer move on.
    onWritten?.({ mine: now, merged });
    return merged;
  });
}

/**
 * Every document with a write not yet finished, whichever document is on screen: when the page
 * goes, each is handed to the background (`MarkSync.handoff`). Tracking only the open document
 * lost the write of one just switched away from.
 */
export const unsettledSyncs = new Set<MarkSync>();

/** What the background needs to finish an editor's write after its tab has gone. */
export interface MarksHandoff {
  type: 'pdf-marks-handoff';
  hash: string;
  name: string;
  baseline: Mark[];
  current: Mark[];
}

/** The stored marks of one document, for one editor. */
export class MarkSync {
  /** A write is under way (it may not finish if the tab closes now). */
  private writing = 0;
  /** Where to read the marks a write — or a handoff — must deliver. */
  private latest: (() => readonly Mark[]) | null = null;
  private baseline: Mark[];
  /** What this editor last wrote, to recognise its own write coming back through the watch. */
  private lastWritten = '';
  private stopWatching: (() => void) | null = null;

  constructor(
    private hash: string,
    private readonly name: string,
    baseline: readonly Mark[],
  ) {
    this.baseline = [...baseline];
  }

  get documentHash(): string {
    return this.hash;
  }

  /**
   * Write this editor's changes since it last synced; returns the marks now stored. `current` is
   * read when the write runs (pass the editor's marks as a function); an array is taken as it is.
   */
  async persist(current: readonly Mark[] | (() => readonly Mark[])): Promise<Mark[]> {
    const hash = this.hash;
    const read = typeof current === 'function' ? current : () => current;
    this.latest = read;
    this.writing++;
    unsettledSyncs.add(this);
    try {
      return await persistChanges(
        hash,
        this.name,
        () => this.baseline,
        read,
        // Noted before writing: the storage event for this write can arrive before `setItem` returns.
        (merged) => (this.lastWritten = canon(merged)),
        ({ mine }) => {
          // The baseline moves on only once the write has *succeeded* (a tab closed mid-write
          // must still hand the change off), and it moves to the marks this editor wrote — not
          // to the merged result, which may hold marks from elsewhere it has never shown. Taken
          // as the baseline, those looked like this editor's deletions on its next write: a note
          // restored meanwhile was removed by the second flush of an editor switched away from.
          // Still inside the lock: the next write queued from this editor sees it.
          if (hash === this.hash) this.baseline = [...mine];
        },
      );
    } finally {
      if (--this.writing === 0) unsettledSyncs.delete(this);
    }
  }

  /**
   * The tab is closing. A change still waiting for its write — or with its write under way — would
   * be lost with the page: hand it to the background, which outlives the tab and applies it by the
   * same rules. Null when there is nothing unwritten.
   */
  handoff(current?: readonly Mark[], pending = false): MarksHandoff | null {
    if (!pending && this.writing === 0) return null;
    const marks = current ?? this.latest?.();
    if (!marks) return null;
    return { type: 'pdf-marks-handoff', hash: this.hash, name: this.name, baseline: [...this.baseline], current: [...marks] };
  }

  /**
   * Follow other tabs: `onRemote` gets the marks to show — theirs, with this editor's unsaved
   * changes still on top. `current` reads this editor's marks at that moment.
   */
  watch(current: () => readonly Mark[], onRemote: (marks: Mark[]) => void): void {
    this.stopWatching?.();
    const hash = this.hash;
    this.stopWatching = storage.watch(`local:pdfMarks:${hash}`, (value) => {
      if (hash !== this.hash) return;
      const stored = normalizeStoredMarks(value);
      if (!stored) return;
      const theirs = stored.marks as Mark[];
      const text = canon(theirs);
      // This editor's own write coming back: nothing new.
      if (text === this.lastWritten || text === canon(this.baseline)) return;
      const now = current();
      const shown = reconcileMarks(theirs, this.baseline, now);
      this.baseline = theirs;
      // Only when something on screen changes: taking marks in clears the undo history.
      if (canon(shown) !== canon(now)) onRemote(shown);
    });
  }

  /**
   * The file was saved and is now a different document (new bytes, new hash): carry `marks` —
   * the editor's marks *now*, including anything typed while saving — over to it.
   */
  async moveTo(hash: string, marks: readonly Mark[]): Promise<void> {
    this.stopWatching?.();
    this.stopWatching = null;
    this.hash = hash;
    const stored = await loadMarks(hash).catch(() => null);
    this.baseline = stored ? (stored.marks as Mark[]) : [];
    await this.persist(marks);
  }

  /** Stop following other tabs. Writes already started still finish (and stay in `unsettledSyncs`). */
  dispose(): void {
    this.stopWatching?.();
    this.stopWatching = null;
  }
}
