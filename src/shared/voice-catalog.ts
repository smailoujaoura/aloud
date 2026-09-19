/**
 * Reading the bundled model manifest (`models.json`) as a list of pickable voices.
 *
 * Both voice pickers — the in-page control bar and the options page — need the same thing:
 * "which voices does this engine offer, and how should they be grouped?". The three engines
 * store that differently in the manifest (Piper has one entry per downloadable voice, Kokoro and
 * Supertonic have one shared model with many styles), so the shape difference is absorbed here
 * rather than in each caller.
 */
import type { ModelManifest } from '@/engine/engines/types';
import type { EngineId } from '@/shared/settings';
import { ENGINE_IDS } from './engine-catalog';

export interface VoiceOption {
  /** Voice key as stored in settings, e.g. `en_US-hfc_female-medium` or `af_heart`. */
  id: string;
  label: string;
  /** Heading to group under — the language for Piper and Kokoro, which are multilingual. */
  group: string;
}

/** Every voice the engine defines, whether or not its files are downloaded yet. */
export function listVoices(engine: EngineId, manifest: ModelManifest): VoiceOption[] {
  switch (engine) {
    case 'kokoro':
      return Object.entries(manifest.kokoro.voices).map(([id, v]) => ({
        id,
        label: `${v.label} · ${v.gender}`,
        group: v.language,
      }));
    case 'supertonic':
      return Object.entries(manifest.supertonic?.voices ?? {}).map(([id, v]) => ({
        id,
        label: `${v.label} · ${v.gender}`,
        group: 'English',
      }));
    default:
      return Object.entries(manifest.piper).map(([id, v]) => ({
        id,
        label: `${shortPiperLabel(v.label)} · ${v.quality}`,
        group: v.languageName ?? v.language,
      }));
  }
}

/** Piper labels read "Name — Language (Country)"; the picker only needs the name. */
export function shortPiperLabel(label: string): string {
  return label.split(' — ')[0] ?? label;
}

export function isEnglish(language: string): boolean {
  return /english|^en\b/i.test(language);
}

/**
 * Group voices for display, English first and the rest alphabetical.
 *
 * English leads because the Piper catalogue alone has 175 voices across dozens of languages, and
 * burying the ones most readers want behind "Bengali… Catalan… Danish…" makes the picker
 * unusable. Within a group the manifest's own order is kept.
 */
export function groupByLanguage(voices: VoiceOption[]): Array<[string, VoiceOption[]]> {
  const byGroup = new Map<string, VoiceOption[]>();
  for (const v of voices) {
    const key = v.group || 'Other';
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(v);
    else byGroup.set(key, [v]);
  }
  return [...byGroup.entries()].sort(([a], [b]) => {
    const rank = (lang: string): number => (isEnglish(lang) ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

/**
 * A voice on the reading bar, where voices from every engine share one picker: the value is
 * `engine:voice` so choosing Kokoro's af_heart while Piper reads is unambiguous.
 */
export type EngineVoice = VoiceOption & { engine: EngineId };

export function voiceValue(engine: EngineId, id: string): string {
  return `${engine}:${id}`;
}

/** `piper:en_GB-alba-medium` -> { engine, id }; a bare id (older bars) keeps the current engine. */
export function parseVoiceValue(value: string, current: EngineId): { engine: EngineId; id: string } | null {
  const at = value.indexOf(':');
  if (at < 0) return value ? { engine: current, id: value } : null;
  const engine = value.slice(0, at) as EngineId;
  const id = value.slice(at + 1);
  if (!ENGINE_IDS.includes(engine) || !id) return null;
  return { engine, id };
}
