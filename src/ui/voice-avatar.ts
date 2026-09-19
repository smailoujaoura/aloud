/**
 * Portraits for voices: small illustrated avatars, drawn in SVG, one per voice. The best voices
 * have a photographic portrait instead (voice-portraits.ts); this is every other voice's, and the
 * fallback if a photo fails to load.
 *
 * They are not photographs of anyone — none of these voices has a face — but a list of 175 names
 * is scanned faster with pictures, and a voice described as female or male should look it. Each
 * voice gets the same portrait every time: skin tone, hair, clothing and background are drawn
 * from a seed made of its id.
 *
 * Gender comes from the voice data where it exists (Kokoro, Supertonic) and, for Piper, whose
 * catalogue has none, from a list of voice names whose speaker is known. Anything not on that
 * list, and the datasets recorded from many speakers, get an abstract badge or a group rather
 * than a guessed face.
 */
import type { ModelManifest } from '@/engine/engines/types';
import type { EngineId } from '@/shared/settings';

export type VoiceGender = 'female' | 'male' | 'mixed' | 'unknown';

/** Piper voices, by the name part of their id (`en_GB-alba-medium` -> `alba`), whose speaker is known. */
const PIPER_FEMALE = new Set([
  'alba', 'amy', 'lessac', 'ljspeech', 'kathleen', 'kristin', 'cori', 'jenny_dioco', 'southern_english_female',
  'hfc_female', 'aegis_female', 'siwis', 'eva_k', 'kerstin', 'ramona', 'paola', 'daniela', 'irina', 'tetiana', 'lada',
  'gosia', 'berta', 'salka', 'ugla', 'meera', 'priyamvada', 'padmavathi', 'maya', 'natia', 'anna', 'alma', 'lisa',
  'lili', 'nathalie', 'serena', 'raya', 'joy', 'kasandra', 'marylux', 'maider', 'rapunzelina', 'huayan', 'xiao_ya',
  'upc_ona',
]);
const PIPER_MALE = new Set([
  'ryan', 'joe', 'john', 'norman', 'danny', 'bryce', 'alan', 'kusal', 'hfc_male', 'northern_english_male', 'thorsten',
  'thorsten_emotional', 'gilles', 'karlsson', 'riccardo', 'davefx', 'carlfm', 'tom', 'denis', 'dmitri', 'ruslan',
  'mykyta', 'artur', 'jirka', 'darkman', 'mihai', 'steinn', 'harri', 'pratham', 'rohan', 'arjun', 'venkatesh', 'amir',
  'reza_ibrahim', 'kareem', 'fasih', 'imre', 'edon', 'dimitar', 'aivars', 'antton', 'gor', 'cadu', 'faber',
  'edresson', 'jeff', 'mike', 'upc_pau', 'pavoque',
]);
/** Datasets recorded from many speakers. */
const PIPER_MIXED = new Set(['arctic', 'l2arctic', 'libritts', 'libritts_r', 'vctk', 'semaine', 'aru', 'mls', 'google']);

/** `en_GB-alba-medium` -> `alba`. */
export function piperVoiceName(id: string): string {
  const parts = id.split('-');
  return parts.length >= 3 ? parts.slice(1, -1).join('-') : (parts[1] ?? id);
}

export function voiceGender(engine: EngineId, id: string, manifest: ModelManifest | null): VoiceGender {
  if (engine === 'kokoro' || engine === 'supertonic') {
    const voices = engine === 'kokoro' ? manifest?.kokoro.voices : manifest?.supertonic?.voices;
    const gender = voices?.[id]?.gender;
    if (gender === 'female' || gender === 'male') return gender;
    // Kokoro ids say it too: af_ / bf_ female, am_ / bm_ male.
    if (engine === 'kokoro' && /^[a-z]f_/.test(id)) return 'female';
    if (engine === 'kokoro' && /^[a-z]m_/.test(id)) return 'male';
    return 'unknown';
  }
  const name = piperVoiceName(id);
  if (PIPER_FEMALE.has(name)) return 'female';
  if (PIPER_MALE.has(name)) return 'male';
  if (PIPER_MIXED.has(name) || name.startsWith('mls_')) return 'mixed';
  return 'unknown';
}

// ---- drawing ---------------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
const SKIN = ['#f6d2b8', '#eab58f', '#d39a6f', '#b07650', '#8a5536', '#5e3a24'];
const HAIR = ['#1f1a17', '#3b2a20', '#5a3a24', '#8a4b2a', '#c79a5b', '#e0c38a', '#8d8d8d'];

/** mulberry32: a tiny seeded generator, so the same id always draws the same face. */
function random(seed: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353) >>> 0;
  let a = h;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;

export interface AvatarStyle {
  gender: VoiceGender;
  /** The hairstyle drawn, for tests and for anyone inspecting the markup. */
  hair: string;
  beard: boolean;
}

/** Which portrait a voice gets — decided separately from drawing it, so it can be tested. */
export function avatarStyle(seed: string, gender: VoiceGender): AvatarStyle {
  const rnd = random(`${seed}:style`);
  if (gender === 'female') return { gender, hair: pick(rnd, ['long', 'bob', 'bun', 'curls']), beard: false };
  if (gender === 'male') {
    const hair = pick(rnd, ['crop', 'side', 'buzz', 'curly-short']);
    return { gender, hair, beard: rnd() < 0.35 };
  }
  return { gender, hair: gender === 'mixed' ? 'group' : 'none', beard: false };
}

/** An avatar for voice `seed` (its id), `size` pixels square. */
export function voiceAvatar(doc: Document, seed: string, gender: VoiceGender, size = 34): SVGSVGElement {
  const style = avatarStyle(seed, gender);
  const rnd = random(seed);
  const hue = Math.floor(rnd() * 360);
  const svg = doc.createElementNS(NS, 'svg');
  // Framed on the head and shoulders: at 34 px a whole-figure portrait is mostly background.
  svg.setAttribute('viewBox', '10 7 44 44');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.gender = style.gender;
  svg.dataset.hair = style.hair;
  if (style.beard) svg.dataset.beard = 'true';

  const node = (tag: string, attrs: Record<string, string | number>): SVGElement => {
    const el = doc.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  };
  const clipId = `av-${Math.floor(rnd() * 1e9).toString(36)}`;
  const defs = node('defs', {});
  const clip = node('clipPath', { id: clipId });
  clip.append(node('circle', { cx: 32, cy: 29, r: 22 }));
  defs.append(clip);
  svg.append(defs);
  const g = node('g', { 'clip-path': `url(#${clipId})` });
  svg.append(g);
  g.append(node('rect', { width: 64, height: 64, fill: `hsl(${hue} 62% 86%)` }));

  if (style.gender === 'unknown') {
    // Not a face: a voice, drawn as the sound it makes.
    const ink = `hsl(${hue} 45% 38%)`;
    [10, 18, 26, 14, 22, 12].forEach((h, i) => {
      g.append(node('rect', { x: 13 + i * 7, y: 32 - h / 2, width: 4, height: h, rx: 2, fill: ink }));
    });
    return svg;
  }

  if (style.gender === 'mixed') {
    // A group recording: two small figures.
    person(g, node, rnd, { cx: 23, scale: 0.72, gender: 'female', hair: 'bob', beard: false, hue });
    person(g, node, rnd, { cx: 41, scale: 0.72, gender: 'male', hair: 'crop', beard: false, hue });
    return svg;
  }

  person(g, node, rnd, { cx: 32, scale: 1, gender: style.gender, hair: style.hair, beard: style.beard, hue });
  return svg;
}

type Make = (tag: string, attrs: Record<string, string | number>) => SVGElement;

function person(
  g: SVGElement,
  node: Make,
  rnd: () => number,
  p: { cx: number; scale: number; gender: 'female' | 'male'; hair: string; beard: boolean; hue: number },
): void {
  const skin = pick(rnd, SKIN);
  // Hair close in tone to the skin makes the face disappear at 34 px: keep only colours that
  // stand apart from it.
  const hair = pick(rnd, HAIR.filter((h) => Math.abs(luminance(h) - luminance(skin)) > 0.16));
  const shirt = `hsl(${(p.hue + 150 + Math.floor(rnd() * 90)) % 360} 45% 46%)`;
  const s = p.scale;
  const x = (v: number): number => p.cx + (v - 32) * s;
  const y = (v: number): number => 64 - (64 - v) * s;
  const wrap = node('g', {});
  g.append(wrap);

  // Hair that falls behind the head and shoulders.
  if (p.hair === 'long') {
    wrap.append(node('path', { d: `M${x(18)} ${y(30)} C${x(17)} ${y(14)} ${x(25)} ${y(10)} ${x(32)} ${y(10)} C${x(39)} ${y(10)} ${x(47)} ${y(14)} ${x(46)} ${y(30)} L${x(48)} ${y(50)} L${x(16)} ${y(50)} Z`, fill: hair }));
  } else if (p.hair === 'bob') {
    wrap.append(node('path', { d: `M${x(19)} ${y(29)} C${x(18)} ${y(14)} ${x(25)} ${y(11)} ${x(32)} ${y(11)} C${x(39)} ${y(11)} ${x(46)} ${y(14)} ${x(45)} ${y(29)} L${x(46)} ${y(40)} L${x(18)} ${y(40)} Z`, fill: hair }));
  } else if (p.hair === 'curls') {
    for (const [cx, cy, r] of [[20, 22, 7], [44, 22, 7], [24, 14, 7], [40, 14, 7], [32, 11, 7], [19, 32, 6], [45, 32, 6], [20, 40, 5], [44, 40, 5]] as const) {
      wrap.append(node('circle', { cx: x(cx), cy: y(cy), r: r * s, fill: hair }));
    }
  }

  // Shoulders, neck, head.
  wrap.append(node('path', { d: `M${x(8)} 64 C${x(10)} ${y(48)} ${x(21)} ${y(44)} ${x(32)} ${y(44)} C${x(43)} ${y(44)} ${x(54)} ${y(48)} ${x(56)} 64 Z`, fill: shirt }));
  wrap.append(node('rect', { x: x(28), y: y(36), width: 8 * s, height: 10 * s, rx: 3 * s, fill: skin }));
  wrap.append(node('ellipse', { cx: x(32), cy: y(27), rx: 11 * s, ry: 12.5 * s, fill: skin }));

  // Hair on top of the head.
  if (p.hair === 'long' || p.hair === 'bob') {
    wrap.append(node('path', { d: `M${x(20.5)} ${y(26)} C${x(20)} ${y(15)} ${x(26)} ${y(13)} ${x(32)} ${y(13)} C${x(38)} ${y(13)} ${x(44)} ${y(15)} ${x(43.5)} ${y(26)} C${x(40)} ${y(20)} ${x(36)} ${y(18.5)} ${x(29)} ${y(19)} C${x(25)} ${y(19.5)} ${x(22)} ${y(22)} ${x(20.5)} ${y(26)} Z`, fill: hair }));
  } else if (p.hair === 'bun') {
    wrap.append(node('circle', { cx: x(32), cy: y(10), r: 6 * s, fill: hair }));
    wrap.append(node('path', { d: `M${x(20.5)} ${y(26)} C${x(20)} ${y(15)} ${x(26)} ${y(14)} ${x(32)} ${y(14)} C${x(38)} ${y(14)} ${x(44)} ${y(15)} ${x(43.5)} ${y(26)} C${x(41)} ${y(19)} ${x(23)} ${y(19)} ${x(20.5)} ${y(26)} Z`, fill: hair }));
  } else if (p.hair === 'curls') {
    for (const [cx, cy] of [[25, 17], [32, 15], [39, 17]] as const) wrap.append(node('circle', { cx: x(cx), cy: y(cy), r: 5 * s, fill: hair }));
  } else if (p.hair === 'crop') {
    wrap.append(node('path', { d: `M${x(20.5)} ${y(25)} C${x(20)} ${y(15)} ${x(26)} ${y(13.5)} ${x(32)} ${y(13.5)} C${x(38)} ${y(13.5)} ${x(44)} ${y(15)} ${x(43.5)} ${y(25)} C${x(41)} ${y(20)} ${x(36)} ${y(19)} ${x(32)} ${y(19)} C${x(28)} ${y(19)} ${x(23)} ${y(20)} ${x(20.5)} ${y(25)} Z`, fill: hair }));
  } else if (p.hair === 'side') {
    wrap.append(node('path', { d: `M${x(20.5)} ${y(26)} C${x(19.5)} ${y(15)} ${x(26)} ${y(12.5)} ${x(33)} ${y(12.5)} C${x(40)} ${y(12.5)} ${x(44.5)} ${y(16)} ${x(43.5)} ${y(25)} C${x(40)} ${y(18)} ${x(30)} ${y(21)} ${x(24)} ${y(19)} C${x(22)} ${y(21)} ${x(21)} ${y(23)} ${x(20.5)} ${y(26)} Z`, fill: hair }));
  } else if (p.hair === 'buzz') {
    wrap.append(node('path', { d: `M${x(21)} ${y(23)} C${x(21)} ${y(16)} ${x(26)} ${y(14.5)} ${x(32)} ${y(14.5)} C${x(38)} ${y(14.5)} ${x(43)} ${y(16)} ${x(43)} ${y(23)} C${x(40)} ${y(19)} ${x(24)} ${y(19)} ${x(21)} ${y(23)} Z`, fill: hair, opacity: 0.85 }));
  } else if (p.hair === 'curly-short') {
    for (const [cx, cy] of [[23, 20], [28, 16], [34, 15], [40, 17], [42, 22], [22, 25]] as const) wrap.append(node('circle', { cx: x(cx), cy: y(cy), r: 4.2 * s, fill: hair }));
  }

  if (p.beard) {
    wrap.append(node('path', { d: `M${x(21.5)} ${y(29)} C${x(22)} ${y(38)} ${x(27)} ${y(40.5)} ${x(32)} ${y(40.5)} C${x(37)} ${y(40.5)} ${x(42)} ${y(38)} ${x(42.5)} ${y(29)} C${x(40)} ${y(34)} ${x(36)} ${y(35)} ${x(32)} ${y(35)} C${x(28)} ${y(35)} ${x(24)} ${y(34)} ${x(21.5)} ${y(29)} Z`, fill: hair }));
  }

  // Face: eyes and a small smile.
  const ink = '#2a211c';
  wrap.append(node('circle', { cx: x(27.5), cy: y(27), r: 1.4 * s, fill: ink }));
  wrap.append(node('circle', { cx: x(36.5), cy: y(27), r: 1.4 * s, fill: ink }));
  wrap.append(node('path', { d: `M${x(28.5)} ${y(32)} Q${x(32)} ${y(34.6)} ${x(35.5)} ${y(32)}`, stroke: p.beard ? '#f3e9e2' : ink, 'stroke-width': 1.4 * s, fill: 'none', 'stroke-linecap': 'round' }));
}

/** Relative luminance of a `#rrggbb` colour, 0..1. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
