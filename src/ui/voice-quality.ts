/**
 * How good a voice sounds, for ordering the lists.
 *
 * A catalogue of 171 Piper voices in alphabetical order buries the handful anyone should actually
 * choose. So the lists lead with the voices judged best — the ones with a portrait, in a fixed
 * order — and everything after them is ranked by what the catalogue knows about quality: Piper's
 * recording tier (`high` beats `medium` beats `low`) and Kokoro's own published grades. Names only
 * break ties.
 */
import type { ModelManifest, PiperVoiceEntry } from '@/engine/engines/types';
import type { EngineId } from '@/shared/settings';
import { bestVoiceIndex, voicePortrait } from './voice-portraits';

/** Piper's quality tiers, best first. */
const PIPER_TIERS = ['high', 'medium', 'low', 'x_low'];
/** Kokoro's published grades, best first. */
export const GRADE_ORDER = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F+', 'F'];

/** Rank for ordering: lower sorts first. Voices with a portrait come first, in their own order. */
export function voiceRank(engine: EngineId, id: string, manifest: ModelManifest, variants?: readonly PiperVoiceEntry[]): number {
  const best = bestVoiceIndex(engine, id);
  if (best != null) return best;
  const AFTER_BEST = 1000;
  if (engine === 'piper') {
    const entries = variants ?? (manifest.piper[id] ? [manifest.piper[id]!] : []);
    const tier = Math.min(...entries.map((v) => tierIndex(v.quality)), PIPER_TIERS.length);
    return AFTER_BEST + tier * 10;
  }
  if (engine === 'kokoro') {
    const grade = manifest.kokoro.voices[id]?.grade;
    const index = grade ? GRADE_ORDER.indexOf(grade) : -1;
    return AFTER_BEST + (index < 0 ? GRADE_ORDER.length : index);
  }
  return AFTER_BEST;
}

function tierIndex(quality: string): number {
  const i = PIPER_TIERS.indexOf(quality);
  return i < 0 ? PIPER_TIERS.length : i;
}

/** Whether this voice is one of the best — the ones with a portrait, listed first. */
export function isBestVoice(engine: EngineId, id: string): boolean {
  return voicePortrait(engine, id) != null;
}
