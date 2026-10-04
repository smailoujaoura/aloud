/**
 * The walkthrough: the page that opens once, when Aloud is installed.
 *
 * Aloud has no window of its own — a toolbar button, a bar drawn over someone else's page, and a
 * settings page nobody opens first. Installation is therefore the one moment it can explain
 * itself, and this is that explanation: five short steps, the control bar drawn and labelled,
 * and — the part that actually teaches it — a real reader session running on this very page, so
 * the first time anyone meets the bar it is over text that does not matter.
 *
 * Everything here is built with `createElement` (see `shared/dom.ts`): no `innerHTML`, so the
 * page passes AMO review the same way the control bar does.
 */
import { browser } from 'wxt/browser';

import { el, svgIcon } from '@/shared/dom';
import { ICON_PATHS } from '@/ui/icons';
import { applyTheme, watchSystemTheme, THEME_LABEL } from '@/ui/theme';
import { createThemeSwitch } from '@/ui/theme-switch';
import { getSettings, setSettings, type ThemeChoice } from '@/shared/settings';
import { listEngines } from '@/shared/engine-catalog';
import { applyGpuProbe, applyWorkerGpuProbe, capabilities } from '@/shared/browser-env';
import { probeGpu } from '@/shared/gpu-probe';
import { loadWorkerGpu } from '@/shared/backend-memory';
import { ReaderSession } from '@/content/session';
import { log } from '@/shared/log';
import { answerTabQueries } from '@/shared/own-tab';

// First, before anything here can fail: lets the background find this tab without the "tabs"
// permission (shared/own-tab.ts). Registered late, an earlier error meant a new tab every time.
answerTabQueries();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let theme: ThemeChoice = 'system';

// ---- toast -----------------------------------------------------------------

let toastTimer = 0;
/** Every action on this page says something back, even the ones that are instant. */
function toast(text: string, kind: 'info' | 'ok' | 'error' = 'info', spinner = false): void {
  const box = $('toast');
  box.className = kind === 'info' ? 'toast' : `toast ${kind}`;
  box.replaceChildren(
    ...(spinner ? [el(document, 'span', { class: 'spinner' })] : []),
    document.createTextNode(text),
  );
  box.hidden = false;
  clearTimeout(toastTimer);
  if (!spinner) toastTimer = window.setTimeout(() => (box.hidden = true), 2400);
}

// ---- theme -----------------------------------------------------------------

/** The segmented light / dark / system control in the header. */
function buildThemeSwitch(): void {
  const { root } = createThemeSwitch(document, theme, (choice) => void chooseTheme(choice));
  $('themeSwitch').replaceChildren(root);
}

async function chooseTheme(choice: ThemeChoice): Promise<void> {
  theme = choice;
  applyTheme(document, choice);
  await setSettings({ theme: choice });
  toast(`Theme: ${THEME_LABEL[choice].toLowerCase()} — applied everywhere Aloud draws`, 'ok');
}

// ---- the control-bar diagram -----------------------------------------------

interface Callout {
  key: keyof typeof ICON_PATHS | 'progress' | 'speed';
  name: string;
  text: string;
}

const CALLOUTS: Callout[] = [
  { key: 'play', name: 'Play and pause', text: 'Or press Space anywhere in the bar.' },
  { key: 'prev', name: 'Back a sentence', text: 'And forward again — one sentence at a time.' },
  {
    key: 'progress',
    name: 'Where you are',
    text: 'Drag it to move through the document; hovering shows the sentence you would land on.',
  },
  { key: 'speed', name: 'Speed', text: 'Half speed up to four times, without the voice changing pitch.' },
  {
    key: 'snap',
    name: 'Back to the reading',
    text: 'Scrolls to the sentence being spoken. It lights up by itself once that sentence is off screen.',
  },
  {
    key: 'target',
    name: 'Click-to-jump',
    text: 'While it is on, clicking any sentence in the page starts reading from there.',
  },
  { key: 'gear', name: 'Settings', text: 'Voices, speed, theme, highlighting and pauses.' },
  { key: 'close', name: 'Stop', text: 'Ends the session and takes the bar away.' },
];

/**
 * A replica of the bar, with every control named underneath it.
 *
 * Drawn from the same `ICON_PATHS` the real bar uses, so the picture in the tutorial cannot
 * drift away from the buttons it is describing.
 */
function buildBarDiagram(): void {
  const host = $('barDiagram');

  const bar = el(document, 'div', { class: 'replica', 'aria-hidden': 'true' });
  const icon = (name: keyof typeof ICON_PATHS, cls = ''): HTMLElement => {
    const box = el(document, 'span', { class: `rep-btn ${cls}`.trim() });
    box.append(svgIcon(document, [...ICON_PATHS[name]], 15));
    return box;
  };
  const track = el(document, 'span', { class: 'rep-progress' });
  track.append(el(document, 'i'));
  bar.append(
    icon('play', 'accent'),
    icon('prev'),
    icon('next'),
    track,
    el(document, 'span', { class: 'rep-count' }, '12/86'),
    el(document, 'span', { class: 'rep-select' }, '1×'),
    icon('snap'),
    icon('target', 'accent'),
    icon('gear'),
    icon('close'),
  );

  const legend = el(document, 'ul', { class: 'legend' });
  for (const callout of CALLOUTS) {
    const li = el(document, 'li');
    const mark = el(document, 'span', { class: 'legend-mark' });
    if (callout.key === 'progress') mark.append(el(document, 'span', { class: 'mini-track' }));
    else if (callout.key === 'speed') mark.append(el(document, 'span', { class: 'mini-speed' }, '1×'));
    else mark.append(svgIcon(document, [...ICON_PATHS[callout.key]], 15));

    const text = el(document, 'span');
    text.append(el(document, 'b', {}, callout.name), document.createTextNode(` — ${callout.text}`));
    li.append(mark, text);
    legend.append(li);
  }

  host.replaceChildren(bar, legend);
}

// ---- engine cards ----------------------------------------------------------

/**
 * The three engines, described by what each one *is*.
 *
 * Not ranked for this machine: a walkthrough that says "recommended here" has to be right about
 * "here", and the honest answer depends on a GPU probe that has not necessarily finished. What
 * does not change is what the engines cost and how they sound.
 */
function buildEngineCards(): void {
  const host = $('engineCards');
  host.replaceChildren(
    ...listEngines().map((info) => {
      const card = el(document, 'div', { class: 'engine-card card' });
      const head = el(document, 'div', { class: 'engine-head' });
      head.append(el(document, 'b', {}, info.name), el(document, 'span', { class: 'pill' }, info.tag));
      card.append(
        head,
        el(document, 'p', { class: 'muted small' }, info.blurb),
        el(document, 'p', { class: 'muted small' }, `Download: ${info.approxSize}`),
      );
      return card;
    }),
  );
}

// ---- the live demo ---------------------------------------------------------

let demo: ReaderSession | null = null;

/**
 * Read this page, here, with the real reader.
 *
 * The whole point of the walkthrough is that the bar stops being unfamiliar, and reading a
 * paragraph the user does not care about is a cheaper place to learn it than the article they
 * actually wanted. `showTips: false` keeps the in-page tips card for that first real page —
 * everything the card says is on screen already.
 */
async function toggleDemo(): Promise<void> {
  const button = $<HTMLButtonElement>('demo');
  const status = $('demoStatus');

  if (demo) {
    await demo.dispose();
    demo = null;
    button.textContent = 'Hear it now';
    button.classList.remove('busy');
    status.textContent = 'Stopped. Start it again whenever you like.';
    return;
  }

  button.classList.add('busy');
  button.textContent = 'Starting…';
  status.textContent = 'Preparing the voice — the bar at the bottom shows how far along it is.';

  const root = $('demoText');
  demo = new ReaderSession();
  try {
    await demo.begin('from-cursor', {
      keepHistory: false,
      targetElement: root,
      showTips: false,
      knownArticle: {
        root,
        text: root.textContent ?? '',
        title: 'Aloud',
        lang: document.documentElement.lang || 'en',
      },
    });
    button.classList.remove('busy');
    button.textContent = 'Stop';
    status.textContent = 'That bar at the bottom is the real thing — try its buttons.';
  } catch (err) {
    log.error('[welcome] demo failed:', err);
    button.classList.remove('busy');
    button.textContent = 'Hear it now';
    status.textContent = 'The demo could not start. The settings page can download a voice by hand.';
    toast('The demo could not start — see the settings page', 'error');
    demo = null;
  }
}

// ---- steps -----------------------------------------------------------------

const steps = Array.from(document.querySelectorAll<HTMLElement>('.step'));
let index = 0;

function showStep(next: number): void {
  index = Math.max(0, Math.min(steps.length - 1, next));
  $('skip').classList.toggle('away', index === steps.length - 1);
  steps.forEach((step, i) => (step.hidden = i !== index));
  $('railFill').style.width = `${((index + 1) / steps.length) * 100}%`;
  // Unavailable buttons keep their place (invisible, not removed), so nothing in the nav moves
  // from one step to the next.
  setAway($<HTMLButtonElement>('back'), index === 0);
  const nextBtn = $<HTMLButtonElement>('next');
  setAway(nextBtn, index === steps.length - 1);
  nextBtn.textContent = index === steps.length - 2 ? 'Last one' : 'Next';

  for (const [i, dot] of dots.entries()) {
    dot.classList.toggle('on', i === index);
    dot.setAttribute('aria-current', String(i === index));
  }
  // Move focus to the step so a screen reader and the keyboard both follow the change.
  const heading = steps[index]?.querySelector('h1');
  heading?.setAttribute('tabindex', '-1');
  (heading as HTMLElement | null)?.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Hide a nav button without taking it out of the layout. */
function setAway(button: HTMLButtonElement, away: boolean): void {
  button.classList.toggle('away', away);
  button.disabled = away;
  button.setAttribute('aria-hidden', String(away));
  button.tabIndex = away ? -1 : 0;
}

/**
 * The demo's reading bar sits at the bottom of the window, where the nav is pinned: lift the nav
 * above it for as long as it is there — however it went away (Stop, its own ✕, the next step).
 */
function watchDemoBar(): void {
  const sync = (): void => {
    document.body.classList.toggle('demo-bar-on', !!document.getElementById('aloud-control-host'));
  };
  // The bar attaches itself to <html>, not <body> (see ui/control-bar.ts).
  new MutationObserver(sync).observe(document.documentElement, { childList: true });
  sync();
}
watchDemoBar();

// "Step 3 of 6" is worked out, not written into each step, so adding one never leaves a stale count.
steps.forEach((step, i) => {
  const eyebrow = step.querySelector('.eyebrow');
  if (eyebrow) eyebrow.textContent = `Step ${i + 1} of ${steps.length}`;
});

const dots: HTMLButtonElement[] = steps.map((step, i) => {
  const dot = el(document, 'button', {
    class: 'dot',
    type: 'button',
    'aria-label': `Step ${i + 1}: ${step.dataset.title ?? ''}`,
  });
  dot.addEventListener('click', () => showStep(i));
  return dot;
});

// ---- wiring ----------------------------------------------------------------

function wire(): void {
  $('next').addEventListener('click', () => showStep(index + 1));
  $('back').addEventListener('click', () => showStep(index - 1));
  $('dots').replaceChildren(...dots);

  $('demo').addEventListener('click', () => void toggleDemo());

  for (const id of ['toVoices', 'toSettings']) {
    $(id).addEventListener('click', () => {
      toast('Opening settings…', 'info');
      void browser.runtime.openOptionsPage();
    });
  }

  const finish = (): void => {
    void demo?.dispose();
    // An extension page may close itself; if the browser refuses, say something rather than
    // leaving a button that appears to do nothing.
    window.close();
    setTimeout(() => toast('You can close this tab whenever you like — Aloud is ready.', 'ok'), 150);
  };
  $('done').addEventListener('click', finish);
  // Skipping ends the tour the same way finishing it does. It can be reopened from the settings.
  $('skip').addEventListener('click', finish);

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'ArrowRight') showStep(index + 1);
    else if (e.key === 'ArrowLeft') showStep(index - 1);
  });

  window.addEventListener('pagehide', () => void demo?.dispose());
}

// ---- entry -----------------------------------------------------------------

void (async () => {
  const settings = await getSettings().catch(() => null);
  theme = settings?.theme ?? 'system';
  applyTheme(document, theme);
  watchSystemTheme(() => {
    if (theme === 'system') applyTheme(document, 'system');
  });

  buildThemeSwitch();
  buildBarDiagram();
  wire();
  showStep(0);

  // The engine ranking depends on whether this machine actually grants a GPU adapter, which is
  // only knowable by asking. Cards are drawn once with the browser-level expectation, then again
  // with the best answer available here: what a synthesis worker last found (the settings page
  // measures that directly), narrowed by a page-side probe on Chromium. This page never spawns a
  // worker of its own — a tutorial is not the place to pay for one.
  buildEngineCards();
  const remembered = await loadWorkerGpu();
  if (remembered != null) applyWorkerGpuProbe(remembered);
  await probeGpu()
    .then((probe) => {
      if (!probe.available && capabilities().engine !== 'gecko') applyGpuProbe(probe);
    })
    .catch(() => undefined);
  buildEngineCards();
})();
