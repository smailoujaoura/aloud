/**
 * Expose a tensor inside an ONNX model as an extra output, without an ONNX library.
 *
 * A Piper (VITS) voice computes how many audio frames each phoneme lasts — the `Ceil` over the
 * duration predictor's output, `w_ceil` in the VITS source — and then throws it away: the
 * exported model's only output is the waveform. Adding that tensor to the graph's outputs makes
 * ONNX Runtime hand it back alongside the audio, at no extra cost, since it was computed anyway.
 *
 * ONNX files are protobuf. `ModelProto.graph` (field 7) holds `GraphProto`, whose `node`s (field
 * 1) carry `op_type` (4) and `output` names (2), and whose `output` list is field 12. A graph
 * output only needs a name (`ValueInfoProto.name`, field 1), so exposing a tensor is: find the
 * graph, append one field 12 to it, and rewrite the graph's length prefix. The weights — nearly
 * all of the file — are copied untouched.
 */

function readVarint(bytes: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  let scale = 1;
  for (;;) {
    const b = bytes[at++];
    if (b === undefined) throw new Error('truncated protobuf');
    value += (b & 0x7f) * scale;
    if (b < 0x80) return [value, at];
    scale *= 128;
  }
}

function writeVarint(value: number): number[] {
  const out: number[] = [];
  while (value >= 0x80) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
}

interface Field {
  no: number;
  /** Where the field's key starts, and where its payload starts and ends. */
  keyAt: number;
  start: number;
  end: number;
}

function* fieldsOf(bytes: Uint8Array, start: number, end: number): Generator<Field> {
  let at = start;
  while (at < end) {
    const keyAt = at;
    const [key, afterKey] = readVarint(bytes, at);
    const no = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const [, next] = readVarint(bytes, afterKey);
      yield { no, keyAt, start: afterKey, end: next };
      at = next;
    } else if (wire === 2) {
      const [len, payload] = readVarint(bytes, afterKey);
      yield { no, keyAt, start: payload, end: payload + len };
      at = payload + len;
    } else if (wire === 5) {
      yield { no, keyAt, start: afterKey, end: afterKey + 4 };
      at = afterKey + 4;
    } else if (wire === 1) {
      yield { no, keyAt, start: afterKey, end: afterKey + 8 };
      at = afterKey + 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

const decoder = new TextDecoder();
const text = (bytes: Uint8Array, f: Field): string => decoder.decode(bytes.subarray(f.start, f.end));

/**
 * The model with the output of its only `opType` node added to the graph outputs, and that
 * output's name. Null when the model has no such node, or more than one (the tensor would be
 * ambiguous), or it is already an output.
 */
export function exposeNodeOutput(model: Uint8Array, opType: string): { model: Uint8Array; name: string } | null {
  let graph: Field | null = null;
  for (const f of fieldsOf(model, 0, model.length)) if (f.no === 7) graph = f;
  if (!graph) return null;

  const found: string[] = [];
  const outputs = new Set<string>();
  for (const f of fieldsOf(model, graph.start, graph.end)) {
    if (f.no === 1) {
      let op = '';
      const produced: string[] = [];
      for (const g of fieldsOf(model, f.start, f.end)) {
        if (g.no === 4) op = text(model, g);
        else if (g.no === 2) produced.push(text(model, g));
      }
      if (op === opType && produced[0]) found.push(produced[0]);
    } else if (f.no === 12) {
      for (const g of fieldsOf(model, f.start, f.end)) if (g.no === 1) outputs.add(text(model, g));
    }
  }
  if (found.length !== 1 || outputs.has(found[0]!)) return null;
  const name = found[0]!;

  const nameBytes = new TextEncoder().encode(name);
  const valueInfo = [0x0a, ...writeVarint(nameBytes.length), ...nameBytes];
  const extra = Uint8Array.from([0x62, ...writeVarint(valueInfo.length), ...valueInfo]);

  // The graph's key is a single byte (field 7, wire type 2 = 0x3a); its length follows.
  const lengthAt = graph.keyAt + 1;
  const newLength = Uint8Array.from(writeVarint(graph.end - graph.start + extra.length));
  const out = new Uint8Array(lengthAt + newLength.length + (graph.end - graph.start) + extra.length + (model.length - graph.end));
  let at = 0;
  out.set(model.subarray(0, lengthAt), at);
  at += lengthAt;
  out.set(newLength, at);
  at += newLength.length;
  out.set(model.subarray(graph.start, graph.end), at);
  at += graph.end - graph.start;
  out.set(extra, at);
  at += extra.length;
  out.set(model.subarray(graph.end), at);
  return { model: out, name };
}
