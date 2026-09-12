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
import { playClip, playSynthesized, stopPreview, type PreviewStatus } from '@/ui/voice-preview';
import type { EngineId, Settings } from '@/shared/settings';
import type { ModelManifest } from '@/engine/engines/types';
import { engineConfigFor } from './engine-config';
import { sharedModelBytes, type CacheSizes } from '@/engine/installed-voices';

const IDLE_LABEL = '▶ Preview';

/**
 * Build a preview button driven by `run`, which reports progress through the callback it is
 * given. Pass `disabledReason` to render it inert with an explanatory tooltip.
 */
export function previewButton(
  run: (onStatus: (s: PreviewStatus) => void) => Promise<void>,
  opts: { disabledReason?: string } = {},
): HTMLButtonElement {
  const btn = el(document, 'button', { class: 'model-btn preview-btn' }, IDLE_LABEL);
  if (opts.disabledReason) {
    btn.disabled = true;
    btn.title = opts.disabledReason;
    return btn;
  }

  let active = false;
  const reset = (): void => {
    active = false;
    btn.textContent = IDLE_LABEL;
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
          s.progress != null && s.loadKind === 'download'
            ? `⬇ ${Math.round(s.progress * 100)}%`
            : '⚙ Preparing…';
        break;
      case 'synthesizing':
        active = true;
        btn.classList.add('busy', 'loading');
        btn.textContent = '♪ Synthesising…';
        break;
      case 'playing':
        active = true;
        btn.classList.remove('loading');
        btn.classList.add('busy');
        btn.textContent = '■ Stop';
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
    btn.textContent = '⚙ Preparing…';
    void run(onStatus);
  });

  return btn;
}

/** Preview `voiceId` for `engine`: a hosted clip for Piper, on-device synthesis otherwise. */
export function previewFor(
  engine: EngineId,
  voiceId: string,
  ctx: { settings: Settings; manifest: ModelManifest; sizes: CacheSizes },
): HTMLButtonElement {
  if (engine === 'piper') {
    const sample = ctx.manifest.piper[voiceId]?.sample;
    if (!sample) {
      return previewButton(async () => {}, { disabledReason: 'No preview clip for this voice' });
    }
    return previewButton((onStatus) => playClip(sample, onStatus));
  }

  const info = engineInfo(engine);
  const ready = info.cacheHint ? sharedModelBytes(ctx.sizes, info.cacheHint) > 0 : false;
  return previewButton(
    (onStatus) =>
      playSynthesized(
        engineConfigFor(ctx.settings, { engine, voice: voiceId, purpose: 'preview' }),
        onStatus,
      ),
    { disabledReason: ready ? undefined : `Download ${info.name} first to preview` },
  );
}
