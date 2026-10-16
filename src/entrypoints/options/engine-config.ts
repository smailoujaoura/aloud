/**
 * Building the `EngineConfig` the options page hands to a worker: the selected engine and voice
 * with the reader's own settings, so a preview or a download fetches exactly what reading uses.
 */
import type { EngineConfig } from '@/engine/protocol';
import { capabilities } from '@/shared/browser-env';
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
  };

  return {
    engine,
    voice: opts.voice ?? voiceOf[engine],
    // Kokoro's download is the build this machine reads with: on a GPU that is the full-precision
    // one. Fetching the smaller CPU build there downloaded a file reading never used, and the
    // first preview then started the real download with no warning. Piper's files are the same
    // either way, so its download stays off the GPU.
    preferWebGPU: opts.purpose === 'download' && engine !== 'kokoro' ? false : settings.preferWebGPU,
    speed: settings.speed,
    // Both purposes are single-shot; the reading pool is sized separately in the synth host.
    workers: 1,
  };
}

/** Does reading here run Kokoro on the GPU — and so need its full-precision build? */
export function readsOnGpu(settings: Settings): boolean {
  return settings.preferWebGPU && capabilities().workerWebGPU;
}
