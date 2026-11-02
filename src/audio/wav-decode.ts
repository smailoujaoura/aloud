/**
 * A WAV file as mono samples: what a speech server sends back when asked for `wav`.
 *
 * Read by hand, not with an AudioContext: decoding happens in a synthesis Worker, which has none.
 * 16-bit, 24-bit and 32-bit integer PCM and 32-bit float are understood; several channels are
 * averaged into one.
 */
export function decodeWav(buffer: ArrayBuffer): { pcm: Float32Array; sampleRate: number } {
  const view = new DataView(buffer);
  const text = (at: number, length: number): string => String.fromCharCode(...new Uint8Array(buffer, at, length));
  if (buffer.byteLength < 12 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error('not a WAV file');

  let format = 0;
  let channels = 1;
  let sampleRate = 0;
  let bits = 16;
  let data: { at: number; length: number } | null = null;
  for (let at = 12; at + 8 <= buffer.byteLength; ) {
    const id = text(at, 4);
    // Servers that stream WAV write 0 or 0xFFFFFFFF as the data size: it runs to the end.
    let size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'data' && (size === 0 || size === 0xffffffff || body + size > buffer.byteLength)) size = buffer.byteLength - body;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format's first two bytes.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { at: body, length: size };
      break;
    }
    at = body + size + (size % 2);
  }
  if (!data || !sampleRate || !channels) throw new Error('WAV file has no audio');

  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const pcm = new Float32Array(frames);
  const read = (at: number): number => {
    if (format === 3 && bits === 32) return view.getFloat32(at, true);
    if (format !== 1) throw new Error(`WAV format ${format} is not supported`);
    if (bits === 16) return view.getInt16(at, true) / 32768;
    if (bits === 24) return (((view.getUint8(at + 2) << 24) | (view.getUint8(at + 1) << 16) | (view.getUint8(at) << 8)) >> 8) / 8388608;
    if (bits === 32) return view.getInt32(at, true) / 2147483648;
    if (bits === 8) return (view.getUint8(at) - 128) / 128;
    throw new Error(`${bits}-bit WAV is not supported`);
  };
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(data.at + (f * channels + c) * bytes);
    pcm[f] = sum / channels;
  }
  return { pcm, sampleRate };
}
