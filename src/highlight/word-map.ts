/**
 * Where a word of the *spoken* text is in the *page* text.
 *
 * What the engine speaks is the page's sentence after normalising: "e.g." became "for example",
 * a URL became "link", a pronunciation rule turned "GPU" into "gee pee you". Word timings come
 * back in terms of that spoken text, but the highlight has to land on the page.
 *
 * Both texts are split into words and matched with a longest common subsequence. Most words
 * match one to one. A run of spoken words between two matches — an expansion, a replacement —
 * maps to the whole run of page words between the same two matches, so "for" and "example" both
 * light up "e.g.". A spoken word with no page text across from it at all maps to nothing, and
 * the previous word simply stays lit.
 */

interface Token {
  from: number;
  to: number;
  key: string;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const at = m.index ?? 0;
    const raw = m[0];
    const lead = raw.search(/[\p{L}\p{N}]/u);
    let tail = raw.length;
    while (tail > Math.max(0, lead) && !/[\p{L}\p{N}]/u.test(raw[tail - 1]!)) tail--;
    const inner = lead < 0 ? raw : raw.slice(lead, tail);
    out.push({
      from: at + Math.max(0, lead),
      to: lead < 0 ? at + raw.length : at + tail,
      key: inner.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
    });
  }
  return out;
}

export type SpanMap = (from: number, to: number) => [number, number] | null;

export function spokenToSource(spoken: string, source: string): SpanMap {
  const a = tokens(spoken);
  const b = tokens(source);
  if (spoken === source) {
    return (from, to) => (to > from ? [from, to] : null);
  }

  // Longest common subsequence over word keys.
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const len = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * width + j] =
        a[i]!.key && a[i]!.key === b[j]!.key
          ? len[(i + 1) * width + j + 1]! + 1
          : Math.max(len[(i + 1) * width + j]!, len[i * width + j + 1]!);
    }
  }
  /** For each spoken token, its matching page token, or -1. */
  const match = new Int32Array(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i]!.key && a[i]!.key === b[j]!.key) {
      match[i] = j;
      i++;
      j++;
    } else if (len[(i + 1) * width + j]! >= len[i * width + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }

  /** Page tokens across from spoken token `i`: its match, or the run between neighbouring matches. */
  const pageTokensFor = (i: number): [number, number] | null => {
    if (match[i]! >= 0) return [match[i]!, match[i]!];
    let before = -1;
    for (let k = i - 1; k >= 0; k--) {
      if (match[k]! >= 0) {
        before = match[k]!;
        break;
      }
    }
    let after = m;
    for (let k = i + 1; k < n; k++) {
      if (match[k]! >= 0) {
        after = match[k]!;
        break;
      }
    }
    return after - before > 1 ? [before + 1, after - 1] : null;
  };

  return (from, to) => {
    let start = Infinity;
    let end = -Infinity;
    a.forEach((token, i) => {
      if (token.to <= from || token.from >= to) return;
      const run = pageTokensFor(i);
      if (!run) return;
      start = Math.min(start, b[run[0]]!.from);
      end = Math.max(end, b[run[1]]!.to);
    });
    return end > start ? [start, end] : null;
  };
}
