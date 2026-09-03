/**
 * Building the `EngineConfig` the options page hands to a worker.
 *
 * Previewing and downloading want *different* configs, and conflating them was a real bug: a
 * preview should never trigger a 320 MB download just because full precision is selected, but
 * the Download button must fetch exactly the weights the reader will use. Forcing q8 for both
 * meant choosing "Full precision" and pressing Download quietly re-fetched the quantised model,
 * so the panel said "downloaded" while reading still had to fetch fp32 on first use — which
 * looks exactly like "it won't delete the old one and download this one".
 */
import type { EngineConfig } from '@/engine/protocol';
import type { EngineId, Settings } from '@/shared/settings';

export type ConfigPurpose =
  /** One sentence, one worker, smallest weights that will do. */
  | 'preview'
  /** Fetch and compile exactly what reading will use. */
  | 'download';

export function engineConfigFor(
  settings: Settings,
  opts: { engine?: EngineId; voice?: string; purpose: ConfigPurpose },
): EngineConfig {
  const engine = opts.engine ?? settings.engine;
  const voiceOf: Record<EngineId, string> = {
    piper: settings.piperVoice,
    kokoro: settings.kokoroVoice,
    supertonic: settings.supertonicVoice,
  };

  return {
    engine,
    voice: opts.voice ?? voiceOf[engine],
    // Previews always use the small Kokoro weights so that auditioning a voice can never kick
    // off the full-precision download; a real download honours the user's choice.
    dtype: opts.purpose === 'preview' && engine === 'kokoro' ? 'q8' : settings.kokoroDtype,
    steps: settings.supertonicSteps,
    preferWebGPU: settings.preferWebGPU,
    speed: settings.speed,
    // Both purposes are single-shot; the reading pool is sized separately in the synth host.
    workers: 1,
  };
}
