/**
 * Set at build time (scripts/build-worker.mjs, wxt.config.ts, vitest.config.ts): false in the Safari
 * build, which leaves out the engines that read through eSpeak-NG (GPL-3.0), Piper and Kokoro.
 */
declare const __ALOUD_ESPEAK__: boolean;
