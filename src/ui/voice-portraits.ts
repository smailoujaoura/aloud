/**
 * Photographic portraits for the best voices, so each is remembered by a face.
 *
 * None of these people exist: every portrait was generated (SDXL with the SDXL-Lightning UNet,
 * both openrail++) from a description of how the voice sounds — who it sounds like, how old,
 * from where. Only the voices worth coming back to get one; every other voice keeps its drawn
 * avatar (see voice-avatar.ts). The files live in `public/portraits/`, 160 px WebP.
 *
 * Piper voices are matched by speaker (`en_US-lessac-high` → `lessac`), so every quality tier of
 * a voice shows the same face.
 */
import type { EngineId } from '@/shared/settings';
import { piperVoiceName } from '@/ui/voice-avatar';

export interface Portrait {
  /** Path under the extension root. */
  file: string;
  /** Who the voice sounds like — the description the portrait was made from. */
  sounds: string;
}

const PIPER: Record<string, string> = {
  alba: 'a Scottish woman of about 20',
  lessac: 'an American woman in her late thirties',
  cori: 'an Englishwoman in her forties',
  ljspeech: 'an American woman in her thirties',
  ryan: 'an American man in his thirties',
  northern_english_male: 'a man from the North of England in his forties',
};

const KOKORO: Record<string, string> = {
  af_heart: 'an American woman in her mid-twenties',
  af_bella: 'an American woman in her early twenties',
  af_nicole: 'an American woman in her late twenties, speaking softly',
  af_sarah: 'an American woman of about thirty',
  af_kore: 'an American woman in her late twenties',
  af_aoede: 'an American woman in her mid-twenties',
  bf_emma: 'an Englishwoman in her thirties',
  am_michael: 'an American man in his forties',
  am_fenrir: 'an American man in his thirties with a deep voice',
  am_puck: 'an American man in his early twenties',
  bm_george: 'an Englishman in his sixties',
  bm_fable: 'an Englishman in his thirties',
};

/** The portrait for a voice, or null when it keeps the drawn avatar. */
export function voicePortrait(engine: EngineId, id: string): Portrait | null {
  if (engine === 'piper') {
    const name = piperVoiceName(id);
    const sounds = PIPER[name];
    return sounds ? { file: `/portraits/piper-${name}.webp`, sounds } : null;
  }
  if (engine === 'kokoro') {
    const sounds = KOKORO[id];
    return sounds ? { file: `/portraits/kokoro-${id}.webp`, sounds } : null;
  }
  return null;
}

/** Every portrait's file, for the test that checks they all exist. */
export function allPortraitFiles(): string[] {
  return [
    ...Object.keys(PIPER).map((name) => `/portraits/piper-${name}.webp`),
    ...Object.keys(KOKORO).map((id) => `/portraits/kokoro-${id}.webp`),
  ];
}
