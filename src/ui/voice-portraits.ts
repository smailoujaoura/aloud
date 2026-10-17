/**
 * Photographic portraits for the best voices, so each is remembered by a face.
 *
 * None of these people exist: every portrait was generated (SDXL with the SDXL-Lightning UNet,
 * both openrail++) from a description of how the voice sounds — who it sounds like, how old,
 * from where. Every Kokoro voice has one, every Supertonic voice, and the Piper speakers worth
 * coming back to; every
 * other voice shows the one stand-in avatar (see voice-avatar.ts). The files live in
 * `public/portraits/`, 160 px WebP.
 *
 * The order of the PIPER and KOKORO tables is also the order the voice lists lead with
 * (voice-quality.ts): best first. KOKORO_REST has faces too, but no place at the front — those
 * voices are ranked by their published grade like any other.
 *
 * Piper voices are matched by speaker (`en_US-lessac-high` → `lessac`), so every quality tier of
 * a voice shows the same face.
 */
import type { EngineId } from '@/shared/settings';
import { piperVoiceName } from '@/ui/voice-avatar';
import { parseSupertonicVoice } from '@/shared/supertonic-voices';

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

/** Kokoro's remaining voices: a face each, ranked by grade rather than listed first. */
const KOKORO_REST: Record<string, string> = {
  af_alloy: 'an American woman in her mid-thirties',
  af_jessica: 'an American woman in her late twenties',
  af_nova: 'an American woman of about thirty',
  af_river: 'an American woman in her mid-thirties, speaking calmly',
  af_sky: 'an American woman in her late twenties, with an airy voice',
  am_adam: 'an American man in his late thirties',
  am_echo: 'an American man in his early thirties, speaking softly',
  am_eric: 'an American man in his late forties',
  am_liam: 'an American man in his mid-twenties',
  am_onyx: 'an American man in his forties with a deep voice',
  am_santa: 'a jolly American man of about seventy',
  bf_alice: 'an Englishwoman in her mid-twenties',
  bf_isabella: 'an Englishwoman in her mid-thirties',
  bf_lily: 'an Englishwoman in her early twenties',
  bm_daniel: 'an Englishman in his late forties',
  bm_lewis: 'an Englishman in his late thirties with a deep voice',
  ef_dora: 'a Spanish woman of about thirty',
  em_alex: 'a Spanish man in his mid-thirties',
  em_santa: 'a jolly Spanish man of about seventy',
  ff_siwis: 'a Frenchwoman of about thirty',
  hf_alpha: 'an Indian woman in her mid-twenties',
  hf_beta: 'an Indian woman in her mid-thirties',
  hm_omega: 'an Indian man in his mid-forties',
  hm_psi: 'an Indian man in his mid-twenties',
  if_sara: 'an Italian woman in her late twenties',
  im_nicola: 'an Italian man in his early forties',
  pf_dora: 'a Brazilian woman in her late twenties',
  pm_alex: 'a Brazilian man in his early thirties',
  pm_santa: 'a jolly Brazilian man of about seventy',
};

/**
 * Supertonic 3's ten styles, each speaking all 31 languages — so no nationality: who they sound
 * like comes from measuring them (median pitch and its range, reading the same sentence), and the
 * faces are a varied cast. One face per style, in every language.
 */
const SUPERTONIC: Record<string, string> = {
  F1: 'a woman of about thirty, warm and lively',
  F2: 'a young woman in her twenties, bright and expressive',
  F3: 'a woman in her late thirties, calm',
  F4: 'a woman in her twenties, quick and light',
  F5: 'a woman in her forties, low and steady',
  M1: 'a man in his early thirties, expressive',
  M2: 'a man in his fifties, deep and even',
  M3: 'a man in his forties, brisk',
  M4: 'a man in his late twenties, light',
  M5: 'an older man, very deep',
};

/** The portrait for a voice, or null when it keeps the drawn avatar. */
export function voicePortrait(engine: EngineId, id: string): Portrait | null {
  if (engine === 'piper') {
    const name = piperVoiceName(id);
    const sounds = PIPER[name];
    return sounds ? { file: `/portraits/piper-${name}.webp`, sounds } : null;
  }
  if (engine === 'kokoro') {
    const sounds = KOKORO[id] ?? KOKORO_REST[id];
    return sounds ? { file: `/portraits/kokoro-${id}.webp`, sounds } : null;
  }
  if (engine === 'supertonic') {
    const { style } = parseSupertonicVoice(id);
    const sounds = SUPERTONIC[style];
    return sounds ? { file: `/portraits/supertonic-${style}.webp`, sounds } : null;
  }
  return null;
}

/**
 * Where a voice sits among the best, or null when it is not one of them — the order the lists
 * lead with. Piper's speakers come before Kokoro's voices: it is the engine that runs anywhere.
 */
export function bestVoiceIndex(engine: EngineId, id: string): number | null {
  if (engine === 'piper') {
    const i = Object.keys(PIPER).indexOf(piperVoiceName(id));
    return i < 0 ? null : i;
  }
  if (engine === 'kokoro') {
    const i = Object.keys(KOKORO).indexOf(id);
    return i < 0 ? null : Object.keys(PIPER).length + i;
  }
  return null;
}

/** Every portrait's file, for the test that checks they all exist. */
export function allPortraitFiles(): string[] {
  return [
    ...Object.keys(PIPER).map((name) => `/portraits/piper-${name}.webp`),
    ...[...Object.keys(KOKORO), ...Object.keys(KOKORO_REST)].map((id) => `/portraits/kokoro-${id}.webp`),
    ...Object.keys(SUPERTONIC).map((style) => `/portraits/supertonic-${style}.webp`),
  ];
}
