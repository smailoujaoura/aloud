/**
 * The "▶ Preview" button next to every voice.
 *
 * It is a single button that walks a real lifecycle rather than a play/stop toggle, because
 * hearing a voice can take a while: the model may still need downloading, then compiling, then
 * the sentence has to be synthesised. Showing "Stop" during all of that would be a lie, so the
 * button reports each phase and resets itself when the preview ends, fails, or is superseded by
 * another preview.
 *
 * Piper voices play a short hosted clip instead of synthesising, which is why they are instant;
 * the other engines genuinely run the model on this device.
 */
import { el } from '@/shared/dom';
import { engineInfo } from '@/shared/engine-catalog';
import { playClip, playSynthesized, previewSentence, stopPreview, type PreviewStatus } from '@/ui/voice-preview';
import { voiceLanguage } from '@/shared/language-voice';
import type { EngineId, Settings } from '@/shared/settings';
import type { ModelManifest } from '@/engine/engines/types';
import { engineConfigFor, readsOnGpu } from './engine-config';
import { piperDownloaded, sharedModelInstalled, type CacheSizes } from '@/engine/installed-voices';

const IDLE_LABEL = '▶ Preview';

/** What the button says in each state; `compact` is icons alone, for a voice's face. */
const LABELS = {
  full: { idle: IDLE_LABEL, preparing: '⚙ Preparing…', synthesising: '♪ Synthesising…', playing: '■ Stop', download: (p: number) => `⬇ ${p}%` },
  compact: { idle: '▶', preparing: '…', synthesising: '…', playing: '■', download: (p: number) => `${p}%` },
};

export interface PreviewOptions {
  /** Icons only, round: for the switchboard's faces. */
  compact?: boolean;
  /** What a screen reader hears: "Preview Alba". */
  label?: string;
}

/**
 * Build a preview button driven by `run`, which reports progress through the callback it is
 * given. Pass `disabledReason` to render it inert with an explanatory tooltip.
 */
export function previewButton(
  run: (onStatus: (s: PreviewStatus) => void) => Promise<void>,
  opts: { disabledReason?: string } & PreviewOptions = {},
): HTMLButtonElement {
  const L = opts.compact ? LABELS.compact : LABELS.full;
  const btn = el(document, 'button', { type: 'button', class: `model-btn preview-btn${opts.compact ? ' compact' : ''}` }, L.idle);
  if (opts.label) btn.setAttribute('aria-label', opts.label);
  if (opts.disabledReason) {
    btn.disabled = true;
    btn.title = opts.disabledReason;
    return btn;
  }

  let active = false;
  const reset = (): void => {
    active = false;
    btn.textContent = L.idle;
    btn.classList.remove('busy', 'loading');
  };

  const onStatus = (s: PreviewStatus): void => {
    if (s.error) {
      btn.title = s.error;
      btn.classList.add('error');
    } else {
      btn.classList.remove('error');
      if (s.engineInfo) btn.title = `Running on ${s.engineInfo}`;
      else btn.removeAttribute('title');
    }

    switch (s.phase) {
      case 'idle':
        reset();
        break;
      case 'loading':
        active = true;
        btn.classList.add('busy', 'loading');
        btn.textContent =
          s.progress != null && s.loadKind === 'download' ? L.download(Math.round(s.progress * 100)) : L.preparing;
        break;
      case 'synthesizing':
        active = true;
        btn.classList.add('busy', 'loading');
        btn.textContent = L.synthesising;
        break;
      case 'playing':
        active = true;
        btn.classList.remove('loading');
        btn.classList.add('busy');
        btn.textContent = L.playing;
        break;
    }
  };

  btn.addEventListener('click', () => {
    if (active) {
      stopPreview();
      return;
    }
    active = true;
    btn.classList.remove('error');
    btn.classList.add('busy', 'loading');
    btn.textContent = L.preparing;
    void run(onStatus);
  });

  return btn;
}

/** Preview `voiceId` for `engine`: a hosted clip for Piper, on-device synthesis otherwise. */
export function previewFor(
  engine: EngineId,
  voiceId: string,
  ctx: { settings: Settings; manifest: ModelManifest; sizes: CacheSizes },
  look: PreviewOptions = {},
): HTMLButtonElement {
  const said = (): string => previewSentence(voiceLanguage(engine, voiceId, ctx.manifest));
  if (engine === 'piper') {
    const entry = ctx.manifest.piper[voiceId];
    // On this device already: spoken here, as reading would — the hosted sample clip was a
    // request to Hugging Face on every preview of a voice that needed none.
    if (entry && piperDownloaded(entry, ctx.sizes)) {
      return previewButton((onStatus) => playSynthesized(engineConfigFor(ctx.settings, { engine, voice: voiceId, purpose: 'preview' }), onStatus, said()), look);
    }
    const sample = entry?.sample;
    if (!sample) {
      return previewButton(async () => {}, { ...look, disabledReason: 'No preview clip for this voice' });
    }
    return previewButton((onStatus) => playClip(sample, onStatus), look);
  }

  const info = engineInfo(engine);
  // On a GPU, Kokoro speaks only with its full-precision build: with just the CPU build here, a
  // preview would quietly start that download. The model card offers it instead.
  const needsGpuBuild = engine === 'kokoro' && readsOnGpu(ctx.settings);
  const ready = sharedModelInstalled(engine, ctx.sizes, needsGpuBuild ? { gpu: true } : {});
  return previewButton(
    (onStatus) =>
      playSynthesized(
        engineConfigFor(ctx.settings, { engine, voice: voiceId, purpose: 'preview' }),
        onStatus,
        // An Italian voice previews in Italian: the English sentence read with Italian rules is
        // no sample of anything.
        said(),
      ),
    {
      ...look,
      disabledReason: ready
        ? undefined
        : needsGpuBuild && sharedModelInstalled(engine, ctx.sizes)
          ? `Download ${info.name}’s GPU build first to preview`
          : `Download ${info.name} first to preview`,
    },
  );
}
