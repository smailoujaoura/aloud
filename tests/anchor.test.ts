import { describe, it, expect } from 'vitest';
import { createAnchor, findAnchor, textFragmentUrl } from '@/annotate/anchor';

const PAGE = `Functions are prevalent in Rust code.
You've already seen one of the most important functions in the language: the main function.

Rust code uses snake case as the conventional style for function and variable names.`;

function slice(raw: string, found: { start: number; end: number } | null): string | null {
  return found ? raw.slice(found.start, found.end) : null;
}

describe('text anchors', () => {
  it('finds the same passage again', () => {
    const start = PAGE.indexOf('snake case');
    const anchor = createAnchor(PAGE, start, start + 'snake case'.length)!;
    expect(anchor.exact).toBe('snake case');
    expect(slice(PAGE, findAnchor(PAGE, anchor))).toBe('snake case');
  });

  it('survives the page growing above it and whitespace changing', () => {
    const start = PAGE.indexOf('the main function');
    const anchor = createAnchor(PAGE, start, start + 'the main function'.length)!;
    const edited = `A new banner.\n\n${PAGE.replace('language: the', 'language:\n    the')}`;
    expect(slice(edited, findAnchor(edited, anchor))?.replace(/\s+/g, ' ')).toBe('the main function');
  });

  it('tells identical quotes apart by what surrounds them', () => {
    const raw = 'first: the cat sat. second: the cat ran. third: the cat sat.';
    const secondAt = raw.indexOf('the cat', raw.indexOf('second'));
    const anchor = createAnchor(raw, secondAt, secondAt + 'the cat'.length)!;
    expect(findAnchor(raw, anchor)).toEqual({ start: secondAt, end: secondAt + 7 });
    // Even after text is inserted in front, context still picks the second one.
    const moved = `intro. ${raw}`;
    expect(findAnchor(moved, anchor)).toEqual({ start: secondAt + 7, end: secondAt + 14 });
  });

  it('falls back to a case-insensitive match, and gives up when the words are gone', () => {
    const start = PAGE.indexOf('Functions are');
    const anchor = createAnchor(PAGE, start, start + 'Functions are prevalent'.length)!;
    expect(slice(PAGE.replace('Functions are prevalent', 'FUNCTIONS ARE PREVALENT'), findAnchor(PAGE.replace('Functions are prevalent', 'FUNCTIONS ARE PREVALENT'), anchor))).toBe('FUNCTIONS ARE PREVALENT');
    expect(findAnchor('Completely different page.', anchor)).toBeNull();
  });

  it('refuses a whitespace-only selection', () => {
    expect(createAnchor('a   b', 1, 4)).toBeNull();
  });

  it('leaves out context that touches punctuation, which browsers reject', () => {
    const raw = 'If you add a semicolon to the end of an expression, you turn it into a statement, and it will then not return a value.';
    const at = raw.indexOf('you turn');
    const anchor = createAnchor(raw, at, at + 'you turn it into a statement'.length)!;
    expect(textFragmentUrl('https://x.test/a', anchor)).toBe('https://x.test/a#:~:text=you%20turn%20it%20into%20a%20statement');
  });

  it('builds text-fragment links browsers understand', () => {
    const start = PAGE.indexOf('snake case');
    const anchor = createAnchor(PAGE, start, start + 10)!;
    expect(textFragmentUrl('https://doc.rust-lang.org/book/ch03-03.html#x', anchor)).toBe(
      'https://doc.rust-lang.org/book/ch03-03.html#:~:text=Rust%20code%20uses-snake%20case,-as%20the%20conventional',
    );
    const long = createAnchor(PAGE, 0, PAGE.indexOf('main function') + 13)!;
    // Long passages use the start,end form: first and last four words. The passage is followed
    // directly by a full stop, so no suffix: context must be separated by whitespace only.
    expect(textFragmentUrl('https://x.test/a', long)).toBe(
      'https://x.test/a#:~:text=Functions%20are%20prevalent%20in,language%3A%20the%20main%20function',
    );
  });
});
