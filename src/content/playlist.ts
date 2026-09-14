/**
 * Turning a page into an ordered list of things to say.
 *
 * A playlist item pairs the *spoken* text (normalised: numbers expanded, URLs skipped) with the
 * live-DOM `Range` to highlight while it plays. Those are two different text domains — see
 * docs/DESIGN.md §1.6 — and keeping the mapping here, away from playback and UI concerns, is
 * what makes it testable without an AudioContext.
 *
 * Two planners, because the two entry points have different structure available:
 *  - `buildArticlePlaylist` walks the live DOM's *block* model in document order, so every
 *    sentence maps to an exact slice of the text index. What is spoken is what is highlighted.
 *  - `buildSelectionPlaylist` has no reliable block structure (the user dragged across
 *    arbitrary nodes), so it segments the selected string and fuzzy-locates each sentence.
 */
import { buildBlockModel, type BlockRole } from '@/extract/block-model';
import { rangeForSpan, type TextIndex } from '@/extract/text-index';
import { segmentSentences } from '@/segment/sentences';
import { isSpeakable } from '@/segment/normalize';
import { Aligner } from '@/align/fuzzy-align';
import { blocksToRead } from './skip-rules';
import type { SkipSettings } from '@/shared/settings';

export interface PlaylistItem {
  /** Position in the playlist. Doubles as the id used across the worker/scheduler protocol. */
  playId: number;
  /** The normalised text handed to the synthesis engine. */
  spokenText: string;
  /**
   * The text as it appears on the page, before normalising. Kept so the spoken text can be
   * rebuilt mid-read when a pronunciation rule or a speech setting changes.
   */
  sourceText: string;
  /** Highlight range for this exact sentence, or null if it could not be located. */
  range: Range | null;
  /**
   * Where `sourceText` starts in the text index, when it is there exactly — what word
   * highlighting needs to find a word's place on the page. Null when the sentence was located
   * only approximately, or not at all.
   */
  sourceAt: number | null;
  /** Highlight range for the whole enclosing block — the fallback when `range` is null. */
  blockRange: Range | null;
  /** Structural role of the block this sentence belongs to. */
  role: BlockRole;
  /** True when this sentence is the first of a new block (paragraph / list item / heading). */
  startsBlock: boolean;
  /** True when the enclosing block is a heading. */
  isHeading: boolean;
}

export interface PlanOptions {
  /** Flattened live-DOM text plus the node breakpoints needed to build Ranges. */
  index: TextIndex;
  /** BCP-47 language tag, for locale-aware sentence breaking. */
  lang: string;
  /** Upper bound on chunk length before clause-splitting (see content/engine-tuning.ts). */
  maxChars: number;
  /** Applied to every chunk before it is spoken. */
  normalize: (text: string) => string;
}

/** Silence to insert before a sentence, from the user's pause settings. */
export interface PauseSettings {
  sentencePauseMs: number;
  sectionPauseMs: number;
}

/** A heading always gets at least this much of a beat before it, so sections are audible. */
const MIN_HEADING_PAUSE_MS = 250;

/**
 * Article / "read from here": walk the block model in document order and segment each block.
 */
export function buildArticlePlaylist(
  opts: PlanOptions & { referenceText: string; title: string; skip?: SkipSettings },
): PlaylistItem[] {
  const { index, lang, maxChars, normalize, referenceText, title } = opts;
  const allBlocks = buildBlockModel(index, { referenceText, title });
  const blocks = opts.skip
    ? blocksToRead(allBlocks, opts.skip, (b) => index.fullText.slice(b.start, b.end))
    : allBlocks;
  const playlist: PlaylistItem[] = [];

  const push = (item: Omit<PlaylistItem, 'playId'>): void => {
    playlist.push({ ...item, playId: playlist.length });
  };

  for (const block of blocks) {
    // A block with no extent is the synthetic spoken-only title: Readability found a title that
    // does not appear anywhere in the live DOM, so it can be read but never highlighted.
    if (block.end <= block.start) {
      const spoken = normalize(title);
      if (isSpeakable(spoken)) {
        push({
          spokenText: spoken,
          sourceText: title,
          range: null,
          sourceAt: null,
          blockRange: null,
          role: block.role,
          startsBlock: true,
          isHeading: true,
        });
      }
      continue;
    }

    const blockRange = rangeForSpan(index, block.start, block.end);
    const blockText = index.fullText.slice(block.start, block.end);
    const isHeading = block.role === 'heading' || block.role === 'title';
    let first = true;

    for (const chunk of segmentSentences(blockText, { locale: lang, maxChars })) {
      const spoken = normalize(chunk.text);
      if (!isSpeakable(spoken)) continue;
      const at = block.start + chunk.start;
      const range = rangeForSpan(index, at, block.start + chunk.end);
      push({
        spokenText: spoken,
        sourceText: chunk.text,
        range: range ?? blockRange,
        sourceAt: range && index.fullText.startsWith(chunk.text, at) ? at : null,
        blockRange,
        role: block.role,
        startsBlock: first,
        isHeading,
      });
      first = false;
    }
  }

  return playlist;
}

/**
 * Selection mode: segment the selected string and fuzzy-locate each sentence in the live text.
 */
export function buildSelectionPlaylist(opts: PlanOptions & { sourceText: string }): PlaylistItem[] {
  const { index, lang, maxChars, normalize, sourceText } = opts;
  const aligner = new Aligner(index.fullText);
  const playlist: PlaylistItem[] = [];

  for (const chunk of segmentSentences(sourceText, { locale: lang, maxChars })) {
    const spoken = normalize(chunk.text);
    if (!isSpeakable(spoken)) continue;
    const found = aligner.locate(chunk.text, chunk.index);
    playlist.push({
      playId: playlist.length,
      spokenText: spoken,
      sourceText: chunk.text,
      range: found ? rangeForSpan(index, found.start, found.end) : null,
      sourceAt: found && index.fullText.startsWith(chunk.text, found.start) ? found.start : null,
      blockRange: null,
      role: 'paragraph',
      startsBlock: false,
      isHeading: false,
    });
  }

  return playlist;
}

/** Leading silence (seconds) to prepend to a chunk's audio. */
export function leadSilenceSec(item: PlaylistItem | undefined, pauses: PauseSettings): number {
  if (!item) return 0;
  let ms = pauses.sentencePauseMs;
  if (item.startsBlock) ms = Math.max(ms, pauses.sectionPauseMs);
  // The very first item needs no run-up; anywhere else a heading gets a real beat before it.
  if (item.isHeading && item.playId > 0) {
    ms = Math.max(ms, pauses.sectionPauseMs, MIN_HEADING_PAUSE_MS);
  }
  return ms / 1000;
}
