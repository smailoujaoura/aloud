// Not a check: prints how the dialogue corpus is cut into synthesis requests, for before/after
// comparison (PRINT_UTTERANCES=path writes JSON there). Skipped unless asked for.
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { segmentSentences } from '@/segment/sentences';

it.skipIf(!process.env.PRINT_UTTERANCES)('prints the corpus segmentation', () => {
  const corpus = JSON.parse(readFileSync('tests/fixtures/dialogue.json', 'utf8')) as Record<string, string[]>;
  const out: Record<string, string[][]> = {};
  for (const [lang, texts] of Object.entries(corpus)) {
    out[lang] = texts.map((t) => segmentSentences(t, { locale: lang, maxChars: 160, utterances: true }).map((c) => c.text));
  }
  writeFileSync(process.env.PRINT_UTTERANCES!, JSON.stringify(out, null, 1));
});
