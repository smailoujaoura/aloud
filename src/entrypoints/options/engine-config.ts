/**
 * Building the `EngineConfig` the options page hands to a worker: the selected engine and voice
 * with the reader's own settings, so a preview or a download fetches exactly what reading uses.
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
    steps: settings.supertonicSteps,
    preferWebGPU: settings.preferWebGPU,
    speed: settings.speed,
    // Both purposes are single-shot; the reading pool is sized separately in the synth host.
    workers: 1,
  };
}
