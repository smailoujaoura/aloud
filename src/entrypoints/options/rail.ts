/**
 * The right-hand column: what the view you are looking at is for, and the keys that work there.
 *
 * It exists so the middle column can be controls and nothing else. Long explanations used to sit
 * between the settings they described, pushing them apart; hints that only matter once (what a
 * PDF reader is for, which key keeps a passage) live here instead, beside the view rather than
 * inside it. On a narrow window it drops below the controls, and on a phone it goes away.
 */
import { el } from '@/shared/dom';
import type { View } from './app-nav';

interface RailCard {
  title: string;
  /** Paragraphs, in the order they should be read. */
  body: string[];
  /** Key, then what it does. */
  keys?: Array<[string, string]>;
}

const CARDS: Partial<Record<View, RailCard>> = {
  continue: {
    title: 'Continue listening',
    body: [
      'Everything you stopped part-way through, newest first, with how much is left. Opening one takes you back to the sentence you were on.',
      'Aloud remembers the place on this device only — nothing leaves it.',
    ],
  },
  queue: {
    title: 'Up next',
    body: [
      'Articles play here, one after another, on this page. Right-click any article and choose “Add page to reading queue”, or right-click a link to add it without opening it.',
      'A page added from its own tab is kept as text, so it plays even offline.',
    ],
  },
  notes: {
    title: 'Notes',
    body: [
      'Every passage you kept, grouped by the page it came from. Opening one goes back to its place on the page and marks it again.',
      'Exports take whatever the filters show, so you can send one site’s notes without the rest.',
    ],
    keys: [
      ['K', 'keep the selected text, on a page Aloud is running on'],
      ['Alt + K', 'the same, on any page'],
      ['N / Alt + N', 'your notes on the page you are reading'],
    ],
  },
  history: {
    title: 'History',
    body: ['What you listened to and how far you got. It stays on this device, and travels in the backup file with everything else.'],
  },
  voice: {
    title: 'Voices',
    body: [
      'A voice is downloaded once and then runs on this device: no account, no network, nothing sent anywhere.',
      'Piper is small and fast everywhere. Kokoro sounds best and wants a GPU. Supertonic sits between them.',
      'The voices with a photograph are the ones worth starting from; every other voice shows the same stand-in avatar.',
    ],
  },
  reading: {
    title: 'Reading',
    body: [
      'How a page is turned into speech: what is skipped, how long the pauses are, and what happens when you click a sentence.',
      'Skipped parts stay on the page — only the voice passes over them. A selection is always read exactly as selected.',
    ],
  },
  appearance: {
    title: 'Appearance',
    body: [
      'The sentence being read is highlighted in the page itself, and the word being spoken is marked inside it — timed from the voice model’s own phoneme durations, not guessed from the length of the text.',
      'Supertonic reports no word timing, so it highlights the sentence alone.',
      'On a dark page the highlight is paler and fainter — a glow rather than a block — so the page’s own light text stays readable on it. Where a sentence would still be hard to read, its letters are given a colour of their own.',
    ],
  },
  highlights: {
    title: 'Highlights & notes',
    body: [
      'Keep a passage from any page, with your note and tags. It is anchored by its text, so it is found again even when the page around it has changed.',
      'Your highlights appear on a page when Aloud is running there, when you open a note, and by themselves on the sites you list.',
      'While Aloud is reading, they turn into underlines in their own colour, so the only wash on the page is the sentence being read.',
    ],
    keys: [
      ['K', 'keep the selected text (no modifier, where Aloud runs)'],
      ['Alt + K', 'keep it on any page'],
      ['N / Alt + N', 'show this page’s notes'],
      ['Delete', 'remove a mark you have clicked'],
    ],
  },
  speed: {
    title: 'Video & audio speed',
    body: [
      'Aloud’s other job: the speed of any video or audio on a page, from the keyboard, without the site’s own menu.',
      'A speed you choose is kept when the site swaps in the next video. A speed only remembered from last time is offered once and then left alone, so dragging a progress bar never changes it.',
    ],
    keys: [
      ['Alt + M', 'start the control on this page'],
      ['D / S', 'faster / slower'],
      ['Shift + D / S', 'through your presets'],
      ['G', 'your preferred speed, and back'],
      ['R', 'back to 1×'],
    ],
  },
  pdfs: {
    title: 'PDFs',
    body: [
      'A PDF in a tab has no text an extension can reach — Chrome renders it in a plugin, Firefox in its own viewer — so Aloud opens PDFs in a reader of its own.',
      'Press the toolbar button on a PDF and it appears there. On Firefox, and on Chrome without “Allow access to file URLs”, a file on your disk has to be chosen by hand. A PDF on a website is downloaded from that site, so Aloud asks for that one site the first time.',
      'In the original pages you can mark up the page itself, and Save writes the marks into the PDF as standard annotations any viewer shows.',
    ],
    keys: [
      ['H U S', 'highlight, underline, strike through'],
      ['N', 'add a note'],
      ['1–4', 'colours'],
    ],
  },
  pronunciation: {
    title: 'Pronunciation',
    body: [
      'Fix words a voice says wrong — a name, an abbreviation, a technical term. Only what is spoken changes; the page keeps its own words.',
      'Rules apply to every engine and every voice.',
    ],
  },
  advanced: {
    title: 'Advanced',
    body: [
      'Where synthesis runs and how hard it works. Aloud asks a real synthesis worker whether it has a GPU rather than guessing from the browser’s name, so what this page says is what your machine actually does.',
      'More workers read further ahead, at the cost of memory and CPU.',
    ],
  },
  shortcuts: {
    title: 'Shortcuts',
    body: [
      'Two kinds of key. Browser shortcuts work on every page, including ones Aloud has never run on — but the browser takes some of them first, which is why they are checked before they are set.',
      'Single keys work on pages Aloud is already running on, where nothing can intercept them. They are ignored while you are typing.',
    ],
  },
  backup: {
    title: 'Backup & restore',
    body: [
      'One file with every setting, note, queued article, reading position, site speed and PDF mark. Keep it somewhere you already sync and Aloud travels with it.',
      'Restoring merges rather than overwrites: notes kept since the backup are not lost. The voice models are too big for a file, so restoring offers to download the ones the backup had.',
    ],
  },
};

/** Draw the rail for `view`. The host is hidden when there is nothing to say. */
export function renderRail(host: HTMLElement, view: View): void {
  const card = CARDS[view];
  if (!card) {
    host.replaceChildren();
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const box = el(document, 'div', { class: 'rail-card' });
  box.append(el(document, 'h2', {}, card.title), ...card.body.map((text) => el(document, 'p', {}, text)));
  if (card.keys?.length) {
    const keys = el(document, 'dl', { class: 'rail-keys' });
    for (const [key, what] of card.keys) {
      const dt = el(document, 'dt', {});
      // "Shift + D / S" — the words between the keys stay words.
      for (const part of key.split(' ')) {
        dt.append(/^[+/]$/.test(part) ? document.createTextNode(part) : el(document, 'kbd', {}, part));
      }
      keys.append(dt, el(document, 'dd', {}, what));
    }
    box.append(el(document, 'p', { class: 'rail-label' }, 'Keys'), keys);
  }
  host.replaceChildren(box);
}
