/**
 * The settings page's list of pronunciation fixes.
 *
 * Each row is one rule: what is written, how to say it, whether capitalisation matters, which
 * language it is for, a button to hear it in the voice that reads that language, and a button to
 * remove it. Edits save as you type (after a
 * short pause), so there is no Save button to forget — and a reader that is already running picks
 * the change up from its next sentence.
 */
import { el } from '@/shared/dom';
import type { PronunciationRule } from '@/segment/pronunciations';
import type { PreviewStatus } from '@/ui/voice-preview';
import { previewButton } from './preview-button';

export interface PronunciationEditorOptions {
  rules: readonly PronunciationRule[];
  save(rules: PronunciationRule[]): Promise<void>;
  /** Speak `text` in the voice that reads `language` ('' : any language, so guessed from the words). */
  speak(text: string, language: string, onStatus: (s: PreviewStatus) => void): Promise<void>;
  /** The languages a rule can be limited to: those of the downloaded voices. */
  languages: ReadonlyArray<{ code: string; name: string }>;
  /** Who says a rule for `language`, for the hear button's tooltip. */
  speaker?(language: string): string;
  /** Set when the current voice cannot speak yet — shown on every "Hear it" button. */
  speakDisabledReason?: string;
}

/** Quick starts for an empty list: the things people most often fix first. */
const EXAMPLES: PronunciationRule[] = [
  { from: 'GPU', to: 'G P U' },
  { from: 'SQL', to: 'sequel' },
  { from: 'Nguyen', to: 'Win' },
];

const SAVE_DELAY_MS = 500;

export function renderPronunciationEditor(host: HTMLElement, opts: PronunciationEditorOptions): void {
  // Never redraw under someone's cursor: the page re-renders after every save elsewhere, and a
  // rebuilt input loses both focus and whatever was half-typed.
  if (host.contains(document.activeElement)) return;

  const rules = opts.rules.map((r) => ({ ...r }));
  let timer = 0;
  const saveSoon = (): void => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void opts.save(rules), SAVE_DELAY_MS);
  };
  const saveNow = (): void => {
    clearTimeout(timer);
    void opts.save(rules);
  };

  const list = el(document, 'div', { class: 'pron-list' });
  const redraw = (focusIndex?: number): void => {
    list.replaceChildren(
      ...(rules.length
        ? rules.map((rule, i) => row(rule, i))
        : [el(document, 'p', { class: 'voice-empty' }, 'No fixes yet. Add a word Aloud says wrong, or start from an example below.')]),
    );
    if (focusIndex != null) list.querySelectorAll<HTMLInputElement>('.pron-from')[focusIndex]?.focus();
  };

  function row(rule: PronunciationRule, index: number): HTMLElement {
    const item = el(document, 'div', { class: 'pron-row' });

    const from = el(document, 'input', {
      class: 'pron-from',
      type: 'text',
      placeholder: 'Written as',
      'aria-label': 'Written as',
      spellcheck: 'false',
      value: rule.from,
    });
    const to = el(document, 'input', {
      class: 'pron-to',
      type: 'text',
      placeholder: 'Say it as',
      'aria-label': 'Say it as',
      spellcheck: 'false',
      value: rule.to,
    });
    from.addEventListener('input', () => {
      rule.from = from.value;
      saveSoon();
    });
    to.addEventListener('input', () => {
      rule.to = to.value;
      saveSoon();
    });

    const caseToggle = el(
      document,
      'button',
      {
        type: 'button',
        class: `pron-case${rule.matchCase ? ' is-on' : ''}`,
        'aria-pressed': String(Boolean(rule.matchCase)),
        title: 'Match capitalisation exactly (so "US" does not also change "us")',
      },
      'Aa',
    );
    caseToggle.addEventListener('click', () => {
      rule.matchCase = !rule.matchCase;
      caseToggle.classList.toggle('is-on', rule.matchCase);
      caseToggle.setAttribute('aria-pressed', String(rule.matchCase));
      saveNow();
    });

    // Which passages it applies to, and so which voice says it.
    const language = el(document, 'select', { class: 'pron-lang', 'aria-label': 'Language this fix is for', title: 'Only in passages in this language, or in every language' });
    const choices = [...opts.languages];
    if (rule.language && !choices.some((c) => c.code === rule.language)) choices.push({ code: rule.language, name: rule.language });
    language.append(el(document, 'option', { value: '' }, 'Any language'));
    for (const c of choices) language.append(el(document, 'option', { value: c.code }, c.name));
    language.value = rule.language ?? '';

    const hear = previewButton(
      (onStatus) => opts.speak(rule.to.trim() || rule.from.trim() || 'Nothing to say yet.', rule.language ?? '', onStatus),
      { disabledReason: opts.speakDisabledReason },
    );
    hear.classList.add('btn-sm');
    const hearTitle = (): void => {
      const who = opts.speaker?.(rule.language ?? '');
      hear.title = opts.speakDisabledReason ?? (who ? `Hear how ${who} will say it` : 'Hear how it will be said');
    };
    hearTitle();
    language.addEventListener('change', () => {
      if (language.value) rule.language = language.value;
      else delete rule.language;
      hearTitle();
      saveNow();
    });

    const remove = el(document, 'button', { type: 'button', class: 'ghost btn-sm pron-remove', 'aria-label': `Remove ${rule.from || 'this fix'}` }, 'Remove');
    remove.addEventListener('click', () => {
      rules.splice(index, 1);
      saveNow();
      redraw();
    });

    item.append(from, el(document, 'span', { class: 'pron-arrow', 'aria-hidden': 'true' }, '→'), to, caseToggle, language, hear, remove);
    return item;
  }

  const add = el(document, 'button', { type: 'button', class: 'btn-sm' }, '+ Add a word');
  add.addEventListener('click', () => {
    rules.push({ from: '', to: '' });
    redraw(rules.length - 1);
  });

  const examples = el(document, 'div', { class: 'pron-examples' });
  examples.append(el(document, 'span', { class: 'muted small' }, 'Examples:'));
  for (const example of EXAMPLES) {
    const chip = el(document, 'button', { type: 'button', class: 'q-chip' }, `${example.from} → ${example.to}`);
    chip.addEventListener('click', () => {
      if (rules.some((r) => r.from.trim().toLowerCase() === example.from.toLowerCase())) return;
      rules.push({ ...example });
      saveNow();
      redraw();
    });
    examples.append(chip);
  }

  const actions = el(document, 'div', { class: 'pron-actions' });
  actions.append(add, examples);

  redraw();
  host.replaceChildren(list, actions);
}
