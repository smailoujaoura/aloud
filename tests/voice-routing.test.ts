import { describe, it, expect } from 'vitest';
import { routeFor, type RouteContext } from '@/content/voice-routing';
import type { CandidateVoice } from '@/shared/language-voice';

const alba: CandidateVoice = { engine: 'piper', id: 'en_GB-alba-medium', label: 'Alba', language: 'en_GB' };
const paola: CandidateVoice = { engine: 'piper', id: 'it_IT-paola-medium', label: 'Paola', language: 'it_IT' };
const sara: CandidateVoice = { engine: 'kokoro', id: 'if_sara', label: 'Sara', language: 'it' };
const heart: CandidateVoice = { engine: 'kokoro', id: 'af_heart', label: 'Heart', language: 'en-us' };

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  auto: true,
  manual: null,
  saved: alba,
  preferences: {},
  installed: [alba, paola, sara, heart],
  skip: new Set(),
  ...over,
});

const voiceOf = (r: ReturnType<typeof routeFor>) => (r.kind === 'voice' ? `${r.voice.id}:${r.reason}` : 'skip');

describe('routeFor', () => {
  it('reads each language with a voice for it, the saved voice for its own', () => {
    expect(voiceOf(routeFor('en', ctx()))).toBe('en_GB-alba-medium:saved');
    expect(voiceOf(routeFor('it', ctx()))).toBe('it_IT-paola-medium:match');
  });

  it('the voice chosen for a language wins, when it is downloaded', () => {
    expect(voiceOf(routeFor('it', ctx({ preferences: { it: { engine: 'kokoro', voice: 'if_sara' } } })))).toBe('if_sara:preference');
    expect(voiceOf(routeFor('en', ctx({ preferences: { en: { engine: 'kokoro', voice: 'af_heart' } } })))).toBe('af_heart:preference');
    // Chosen, then deleted: passed over, not attempted.
    expect(voiceOf(routeFor('it', ctx({ installed: [alba, paola], preferences: { it: { engine: 'kokoro', voice: 'if_sara' } } })))).toBe(
      'it_IT-paola-medium:match',
    );
  });

  it('Auto passes over hidden voices while a visible one speaks the language, and falls back to them', () => {
    const giulia: CandidateVoice = { engine: 'piper', id: 'it_IT-riccardo-x_low', label: 'Riccardo', language: 'it_IT' };
    const installed = [alba, paola, giulia];
    expect(voiceOf(routeFor('it', ctx({ installed, hidden: new Set(['piper:it_IT-paola-medium']) })))).toBe('it_IT-riccardo-x_low:match');
    expect(voiceOf(routeFor('it', ctx({ installed, hidden: new Set(['piper:it_IT-paola-medium', 'piper:it_IT-riccardo-x_low']) })))).toBe(
      'it_IT-paola-medium:match',
    );
  });

  it('a manual lock reads everything with one voice, whatever the language', () => {
    expect(voiceOf(routeFor('it', ctx({ manual: alba })))).toBe('en_GB-alba-medium:manual');
  });

  it('with Auto off, the saved voice reads everything', () => {
    expect(voiceOf(routeFor('it', ctx({ auto: false })))).toBe('en_GB-alba-medium:off');
  });

  it('no voice for a language: read by the saved voice and marked missing, or skipped if asked', () => {
    expect(voiceOf(routeFor('de', ctx()))).toBe('en_GB-alba-medium:missing');
    expect(routeFor('de', ctx({ skip: new Set(['de']) }))).toEqual({ kind: 'skip', language: 'de' });
  });

  it('no voice for a language: read in English even when the saved voice is not English', () => {
    // An Italian voice saved, a German passage: English (Alba), not Italian.
    expect(voiceOf(routeFor('de', ctx({ saved: paola })))).toBe('en_GB-alba-medium:missing');
    // The voice chosen for English reads it.
    expect(voiceOf(routeFor('de', ctx({ saved: paola, preferences: { en: { engine: 'kokoro', voice: 'af_heart' } } })))).toBe('af_heart:missing');
    // No English voice at all: the saved voice — and English itself does not loop.
    expect(voiceOf(routeFor('de', ctx({ saved: paola, installed: [paola, sara] })))).toBe('it_IT-paola-medium:missing');
    expect(voiceOf(routeFor('en', ctx({ saved: paola, installed: [paola, sara] })))).toBe('it_IT-paola-medium:missing');
  });

  it('an unknown language is read by the saved voice, and says it is unknown', () => {
    expect(voiceOf(routeFor('', ctx()))).toBe('en_GB-alba-medium:unknown');
  });
});
