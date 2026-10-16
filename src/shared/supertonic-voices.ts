/**
 * Supertonic 3's voices, one per language.
 *
 * Supertonic 3 has ten voice styles (F1–F5, M1–M5), and every one of them speaks every one of its
 * 31 languages: the language is not part of the voice but a tag around the text. Everything else
 * in Aloud — routing, the Voice page, a voice chosen per language, previews, backups — has a voice
 * speaking one language. So each style is offered once per language, as `F1@de`: voice F1 reading
 * German. The engine reads both halves back (supertonic.ts).
 *
 * A voice saved before Supertonic 3 is a bare style (`F1`), which Supertonic 2 read in English.
 */
import type { ModelManifest } from '@/engine/engines/types';

/** `F1` + `de` → `F1@de`. */
export function supertonicVoiceId(style: string, language: string): string {
  return `${style}@${language}`;
}

/** `F1@de` → { style: 'F1', language: 'de' }; a bare style (saved by Supertonic 2) is English. */
export function parseSupertonicVoice(id: string): { style: string; language: string } {
  const at = id.lastIndexOf('@');
  if (at < 0) return { style: id, language: 'en' };
  return { style: id.slice(0, at), language: id.slice(at + 1) || 'en' };
}

export interface SupertonicVoice {
  /** `F1@de`. */
  id: string;
  style: string;
  /** "Female 1". */
  label: string;
  gender: string;
  language: string;
}

/** Every style in every language the model reads, styles in manifest order within a language. */
export function supertonicVoices(manifest: Pick<ModelManifest, 'supertonic'>): SupertonicVoice[] {
  const m = manifest.supertonic;
  if (!m) return [];
  const languages = m.languages?.length ? m.languages : ['en'];
  const out: SupertonicVoice[] = [];
  for (const language of languages) {
    for (const [style, v] of Object.entries(m.voices)) {
      out.push({ id: supertonicVoiceId(style, language), style, label: v.label, gender: v.gender, language });
    }
  }
  return out;
}
