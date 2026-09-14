/**
 * Mono PCM → MP3, incrementally.
 *
 * Speech at 64 kbps is indistinguishable from the source for a listener and is about 9.6 MB for
 * twenty minutes. Encoding happens a sentence at a time as audio arrives, so an hour-long article
 * never has to exist as raw PCM (which would be ~300 MB of Float32) before it becomes a file.
 *
 * lamejs is LGPL-3.0, compatible with the extension's GPL-3.0.
 */
import { Mp3Encoder } from '@breezystack/lamejs';

/** Samples handed to LAME per call. Keeps each call short so the page stays responsive. */
const SLICE = 1152 * 32;

export const MP3_KBPS = 64;

export class Mp3Writer {
  private readonly encoder: InstanceType<typeof Mp3Encoder>;
  private readonly parts: Uint8Array[] = [];
  private samples = 0;

  constructor(readonly sampleRate: number) {
    this.encoder = new Mp3Encoder(1, sampleRate, MP3_KBPS);
  }

  /** Append `pcm` (-1..1). */
  write(pcm: Float32Array): void {
    for (let start = 0; start < pcm.length; start += SLICE) {
      const slice = pcm.subarray(start, Math.min(pcm.length, start + SLICE));
      const int16 = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        const s = Math.max(-1, Math.min(1, slice[i]!));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.push(this.encoder.encodeBuffer(int16));
    }
    this.samples += pcm.length;
  }

  /** Append `seconds` of silence. */
  silence(seconds: number): void {
    if (seconds > 0) this.write(new Float32Array(Math.round(seconds * this.sampleRate)));
  }

  get durationSeconds(): number {
    return this.samples / this.sampleRate;
  }

  /** Finish the stream. The writer cannot be used afterwards. */
  finish(): Blob {
    this.push(this.encoder.flush());
    return new Blob(this.parts as BlobPart[], { type: 'audio/mpeg' });
  }

  private push(bytes: ArrayLike<number> & { length: number }): void {
    if (bytes.length > 0) this.parts.push(new Uint8Array(bytes as ArrayLike<number>));
  }
}
