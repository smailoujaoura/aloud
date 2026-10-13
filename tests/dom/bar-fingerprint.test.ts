// @vitest-environment happy-dom
/**
 * The reading bar must add nothing a page can enumerate: no font in document.fonts, nothing
 * outside its closed shadow root but the host element.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('the bar leaves no trace a page can read', () => {
  it('brings no font of its own', () => {
    const raw = readFileSync('src/ui/control-bar.ts', 'utf8') + readFileSync('src/ui/control-bar-styles.ts', 'utf8');
    // Code only: the comments explain why there is no font.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/new FontFace|document\.fonts|fonts\.add|@font-face/);
  });
});
