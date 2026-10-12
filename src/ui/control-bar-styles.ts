/**
 * Styles for the in-page control bar, scoped to its Shadow DOM.
 *
 * Three things drive the layout:
 *
 *  - **The bar must not move when text changes.** Its width is a function of the viewport only,
 *    and everything transient — status ("Loading…", "Buffering…", an error), the scrub preview,
 *    the first-run tips card — is drawn in an element floated *above* the bar rather than inside
 *    it, so the buttons never shift under the pointer.
 *  - **It has to work with a thumb.** Below the narrow breakpoint the controls wrap onto two
 *    rows, hit targets grow to the 44px normally recommended for touch, and the bar sits above
 *    the phone's home indicator via `env(safe-area-inset-bottom)`.
 *  - **It is themed by Aloud, not by the page.** Colours come from custom properties defined on
 *    `:host`, switched by the `data-theme` attribute the session stamps from the user's setting
 *    (src/ui/theme.ts). The `prefers-color-scheme` block below only covers the instant before
 *    that attribute exists.
 *
 * `:host { all: initial }` plus the closed shadow root means the host page's CSS cannot reach
 * anything here, and nothing here escapes.
 */

/** Below this viewport width the bar switches to its two-row touch layout. */
export const NARROW_BREAKPOINT_PX = 560;

export const CONTROL_BAR_CSS = `
:host {
  all: initial;

  --bar-bg: rgba(255,255,255,.92);
  --bar-solid: #ffffff;
  --bar-fg: #17171c;
  --bar-muted: #5f5f6d;
  --bar-hover: rgba(20,20,35,.07);
  --bar-active: rgba(20,20,35,.12);
  --bar-track: rgba(20,20,35,.14);
  --bar-border: rgba(20,20,35,.12);
  --bar-shadow: 0 10px 34px rgba(15,15,30,.18), 0 2px 6px rgba(15,15,30,.08);
  --accent: #ffd60a;
  --accent-hi: #ffe14d;
  --accent-on: #1c1c22;
  --accent-soft: rgba(255,214,10,.22);
  --danger: #c0392b;
  --font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

  /* color-scheme is NOT set here: the host's inline "all: initial" outranks :host rules, so it
     is set inline from ControlBar.applyTheme() instead. */
}

:host([data-theme="dark"]) {
  --bar-bg: rgba(24,24,30,.94);
  --bar-solid: #191920;
  --bar-fg: #f0f0f4;
  --bar-muted: #a0a0ae;
  --bar-hover: rgba(255,255,255,.10);
  --bar-active: rgba(255,255,255,.16);
  --bar-track: rgba(255,255,255,.18);
  --bar-border: rgba(255,255,255,.12);
  --bar-shadow: 0 10px 34px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.35);
  --danger: #ff8a8a;
}

/* Only for the blink before the session stamps data-theme from the saved setting. */
@media (prefers-color-scheme: dark) {
  :host(:not([data-theme])) {
    --bar-bg: rgba(24,24,30,.94);
    --bar-solid: #191920;
    --bar-fg: #f0f0f4;
    --bar-muted: #a0a0ae;
    --bar-hover: rgba(255,255,255,.10);
    --bar-active: rgba(255,255,255,.16);
    --bar-track: rgba(255,255,255,.18);
    --bar-border: rgba(255,255,255,.12);
    --bar-shadow: 0 10px 34px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.35);
    --danger: #ff8a8a;
  }
}

/*
 * The dock is the fixed, viewport-anchored column that holds everything: the tips card, the
 * status pill and the bar, stacked bottom-up. It exists so the floating pieces are positioned
 * *against the bar* — as siblings in a column that grows upwards — rather than against the
 * viewport, and so the bar itself never moves when one of them appears.
 */
.dock {
  position: fixed; left: 50%; bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  z-index: 2147483647;
  box-sizing: border-box;
  width: min(760px, calc(100vw - 20px));
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  /* The bar lays itself out by its own width (the container queries below), not the window's. */
  container-type: inline-size; container-name: aloud-dock;
  /* The gaps between the pieces must not swallow clicks meant for the page underneath. */
  pointer-events: none;
}
.dock > * { pointer-events: auto; }
/* Slid below the window while you scroll down the page (control-bar.ts: watchScrolling). */
.dock { transition: transform 220ms ease, opacity 220ms ease; }
.dock.is-tucked { transform: translate(-50%, calc(100% + 40px)); opacity: 0; }
.dock.is-tucked > * { pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .dock { transition: none; } }

.bar {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  display: flex; align-items: center; gap: 6px;
  padding: 7px 10px; border-radius: 16px;
  background: var(--bar-bg);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  backdrop-filter: blur(14px) saturate(1.4);
  border: 1px solid var(--bar-border);
  color: var(--bar-fg);
  font: var(--font);
  box-shadow: var(--bar-shadow);
}
.bar:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

button {
  all: unset; box-sizing: border-box; flex: 0 0 auto; position: relative;
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 9px; color: inherit;
  transition: background 120ms ease, color 120ms ease, transform 120ms ease, opacity 120ms ease;
}
button:hover { background: var(--bar-hover); }
button:active { background: var(--bar-active); transform: scale(.94); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button[disabled] { opacity: .35; cursor: default; }
button[disabled]:hover { background: none; }

.play {
  width: 36px; height: 36px; border-radius: 11px;
  background: var(--accent); color: var(--accent-on);
}
.play:hover { background: var(--accent-hi); }
.play:active { background: var(--accent-hi); }
.play.attn { animation: aloud-pulse 1.4s ease-in-out infinite; }
.play.loading { cursor: progress; }
.play.loading:hover { background: var(--accent); }
.play .btn-spin {
  width: 16px; height: 16px; box-sizing: border-box;
  border: 2px solid rgba(28,28,34,.28); border-top-color: #1c1c22;
  border-radius: 50%; animation: aloud-spin .8s linear infinite;
}

/* Toggle-style buttons (click-to-jump) read as "on" the way a pressed key does. */
.tap.on { background: var(--accent); color: var(--accent-on); }
.tap.on:hover { background: var(--accent-hi); }

/* Follow: lit while following; a dot when following rests because you scrolled elsewhere, or
   when the sentence being read is out of sight — the moment it is worth pressing. */
.follow.on { color: var(--bar-fg); box-shadow: inset 0 0 0 1.5px var(--accent); }
.follow.offscreen { background: var(--accent-soft); color: var(--bar-fg); }
.follow.offscreen::after {
  content: ''; position: absolute; top: 3px; right: 3px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
}

.sep {
  flex: 0 0 auto; width: 1px; height: 20px; margin: 0 2px;
  background: var(--bar-border);
}

/* The secondary controls, kept together — see the note in control-bar.ts. */
.side { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }

/* ---- sleep timer ---------------------------------------------------------- */

.sleep.on { background: var(--accent-soft); }
.sleep .badge, .save .badge {
  position: absolute; top: -4px; right: -5px;
  min-width: 15px; height: 15px; padding: 0 4px; box-sizing: border-box;
  border-radius: 8px; background: var(--accent); color: var(--accent-on);
  font: var(--font); font-size: 9.5px; line-height: 15px; font-weight: 700; text-align: center;
  pointer-events: none;
}
.sleep .badge[hidden], .save .badge[hidden] { display: none; }
.pop-menu {
  box-sizing: border-box; align-self: flex-end;
  width: min(250px, 100%); padding: 6px;
  display: flex; flex-direction: column;
  border-radius: 12px;
  background: var(--bar-solid); color: var(--bar-fg);
  border: 1px solid var(--bar-border); box-shadow: var(--bar-shadow);
  font: var(--font);
  animation: aloud-rise 140ms ease-out;
}
.pop-menu .menu-title {
  padding: 5px 10px 4px; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .05em; color: var(--bar-muted);
}
.pop-menu button {
  font: var(--font);
  width: 100%; height: auto; justify-content: flex-start;
  padding: 7px 10px; border-radius: 8px; font: var(--font); font-size: 13px;
}
.pop-menu button.is-checked { font-weight: 650; }
.pop-menu button.is-checked::after { content: '✓'; margin-left: auto; padding-left: 12px; }
.export-menu { width: min(280px, 100%); gap: 4px; }
.export-menu .menu-text { margin: 0; padding: 2px 10px 6px; font-size: 12.5px; line-height: 1.45; color: var(--bar-fg); }
.export-menu .menu-text.error { color: var(--bar-muted); }
.export-menu button { justify-content: center; }
.export-menu button.primary { background: var(--accent); color: var(--accent-on); font-weight: 650; }
.export-menu .meter { margin: 0 10px 8px; height: 6px; border-radius: 3px; background: var(--bar-track); overflow: hidden; }
.export-menu .meter > i { display: block; height: 100%; background: var(--accent); transition: width 200ms ease; }
.save.on { background: var(--accent-soft); }

.progress {
  flex: 1 1 auto; min-width: 40px; height: 20px; position: relative;
  cursor: pointer; touch-action: none;
  display: flex; align-items: center;
}
.progress > .track {
  position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
  height: 6px; border-radius: 3px; background: var(--bar-track);
  transition: height 120ms ease;
}
.progress > .track > i {
  position: absolute; left: 0; top: 0; bottom: 0;
  border-radius: 3px; background: var(--accent); width: 0%;
}
/* The knob only appears on hover/drag: at rest the bar should read as a slim progress line. */
.progress > .knob {
  position: absolute; top: 50%; left: 0;
  width: 12px; height: 12px; margin-left: -6px; border-radius: 50%;
  background: var(--accent); border: 2px solid var(--bar-solid);
  transform: translateY(-50%) scale(0);
  transition: transform 120ms ease;
  pointer-events: none;
}
.progress:hover > .knob, .progress.dragging > .knob { transform: translateY(-50%) scale(1); }
.progress:hover > .track, .progress.dragging > .track { height: 8px; }
.progress:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }

/* Scrub preview: which sentence a click would land on. A child of the bar, but absolutely
   positioned, so it is drawn above it without taking part in its layout. */
.scrub {
  position: absolute; bottom: calc(100% + 10px); left: 0;
  transform: translateX(-50%);
  padding: 4px 9px; border-radius: 8px;
  background: var(--bar-solid); color: var(--bar-fg);
  border: 1px solid var(--bar-border);
  box-shadow: var(--bar-shadow);
  font: var(--font); font-size: 12px; white-space: nowrap;
  pointer-events: none;
}
.scrub[hidden] { display: none; }

.count {
  flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--bar-muted);
  white-space: nowrap; padding: 0 2px;
}

/* Words a minute, beside the speed: what "1.5×" actually means for the ear. */
.rate {
  flex: 0 0 auto; font-size: 11.5px; color: var(--bar-muted);
  font-variant-numeric: tabular-nums; white-space: nowrap; padding-right: 2px;
}

/*
 * "all: unset" turns a <select> into an inline box that *wraps*, so a two-word voice name made
 * the bar two lines tall — the one thing the bar must never do. Nowrap + hidden overflow keeps
 * every control on one line whatever the voice is called.
 */
select {
  all: unset; box-sizing: border-box; flex: 0 0 auto;
  cursor: pointer; padding: 4px 7px; border-radius: 8px;
  background: var(--bar-hover); color: inherit; font: inherit;
  max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background 120ms ease;
}
select:hover { background: var(--bar-active); }
select:focus-visible { outline: 2px solid var(--accent); }
/*
 * The open list. Belt and braces with color-scheme above: Chromium paints <option> backgrounds
 * from these rules, and the bar's own translucent background (--bar-bg) would show the page
 * through the popup, so the solid variant is used.
 */
select option, select optgroup { background: var(--bar-solid); color: var(--bar-fg); }
select optgroup { color: var(--bar-muted); font-weight: 600; }
.voice[hidden] { display: none; }

/* Speed, with the live pace under it: one narrow column. */
.speedbox { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; line-height: 1; gap: 1px; }
.speedbox select { padding: 3px 7px; }
.speedbox .rate { padding: 0; font-size: 9.5px; letter-spacing: .01em; }

/* The voice reading now, with the passage's language on its face. */
.voice {
  font: var(--font);
  width: auto; max-width: 132px; height: 32px; padding: 0 9px 0 3px; gap: 7px;
  border-radius: 16px; background: var(--bar-hover);
}
.voice:hover { background: var(--bar-active); }
.voice[hidden] { display: none; }
.voice .face-wrap { position: relative; flex: 0 0 auto; display: inline-flex; }
.voice .voice-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.badge-lang {
  position: absolute; right: -6px; bottom: -4px;
  padding: 0 3px; border-radius: 5px; min-width: 13px; text-align: center;
  font-size: 8.5px; line-height: 12px; font-weight: 750; letter-spacing: .03em;
  background: var(--bar-solid); color: var(--bar-fg); box-shadow: 0 0 0 1px var(--bar-border);
}
.badge-lang[hidden] { display: none; }
.voice.missing .badge-lang { background: var(--accent); color: var(--accent-on); box-shadow: none; }
.voice.manual { box-shadow: inset 0 0 0 1.5px var(--accent); }
.avatar { display: inline-flex; flex: 0 0 auto; border-radius: 50%; overflow: hidden; background: var(--bar-track); }
.avatar img, .avatar svg { display: block; width: 100%; height: 100%; object-fit: cover; }

/* The voice menu: the passage, then faces to pick from. */
.voice-menu { width: min(340px, 100%); max-height: min(70vh, 560px); gap: 4px; }
.voice-head { display: flex; align-items: center; gap: 10px; padding: 6px 8px 4px; }
.voice-head-text { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.voice-head-text b { font-size: 14px; }
.voice-head-text span { color: var(--bar-muted); font-size: 12px; }
.voice-menu .menu-text { margin: 0; padding: 2px 10px 4px; font-size: 12.5px; line-height: 1.45; }
.voice-menu .menu-text.warn { color: var(--bar-fg); background: var(--accent-soft); border-radius: 8px; margin: 2px 6px; padding: 6px 8px; }
.voice-menu .menu-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 10px 4px; font-size: 12.5px; }
.voice-menu .menu-field select { max-width: 170px; }
.voice-menu .menu-actions { display: flex; gap: 6px; padding: 2px 8px 4px; flex-wrap: wrap; }
.voice-menu .menu-actions button { width: auto; padding: 6px 10px; justify-content: center; background: var(--bar-hover); }
.voice-menu .menu-actions button.primary { background: var(--accent); color: var(--accent-on); font-weight: 650; }
.voice-list {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  margin: 2px 0; padding: 2px 0; border-top: 1px solid var(--bar-border); border-bottom: 1px solid var(--bar-border);
}
.voice-group { padding: 8px 10px 3px; font-size: 10.5px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: var(--bar-muted); }
.voice-row { gap: 10px; }
.voice-row.is-current { background: var(--accent-soft); }
.voice-row-text { display: flex; flex-direction: column; min-width: 0; text-align: left; gap: 1px; }
.voice-row-text b { font-weight: 600; }
.voice-row-text span { font-size: 11.5px; color: var(--bar-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.voice-menu .menu-action { justify-content: center; }
.voice-menu .menu-action.primary { background: var(--accent); color: var(--accent-on); font-weight: 650; }
.voice-menu .menu-action.subtle { color: var(--bar-muted); font-size: 12.5px; }

/*
 * The bar by its own width. Where one row cannot hold everything, the progress bar takes a row
 * of its own; narrower still, the voice shows its face without its name. The secondary buttons
 * — settings and close among them — never leave the bar.
 */
.bar { flex-wrap: wrap; }
.progress { min-width: 90px; }
@container aloud-dock (max-width: 700px) {
  .bar { row-gap: 4px; }
  .progress { order: 10; flex: 1 1 70%; }
  .count { order: 11; }
  .spacer { flex: 1 1 auto; }
  .sep:nth-of-type(2) { display: none; }
}
@container aloud-dock (max-width: 620px) {
  .voice .voice-name { display: none; }
  .voice { padding: 0 6px 0 3px; }
}

/* ---- floated status ------------------------------------------------------ */

.toast {
  box-sizing: border-box; max-width: 100%;
  display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 7px 12px; border-radius: 11px;
  background: var(--bar-solid); color: var(--bar-fg);
  border: 1px solid var(--bar-border);
  font: var(--font); font-size: 12.5px;
  box-shadow: var(--bar-shadow);
  text-align: center;
}
.toast[hidden] { display: none; }
.toast .toast-action {
  width: auto; height: auto; padding: 3px 9px; margin-left: 4px; border-radius: 7px;
  background: var(--bar-hover); color: var(--bar-fg); font: inherit; font-weight: 600;
}
.toast .toast-action:hover { background: var(--bar-active); }
.toast.err { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 50%, var(--bar-border)); }
.toast.ok { border-color: color-mix(in srgb, var(--accent) 55%, var(--bar-border)); }

.spinner {
  width: 12px; height: 12px; flex: 0 0 auto;
  border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: var(--accent);
  border-radius: 50%; animation: aloud-spin .8s linear infinite;
}

/* ---- first-run tips ------------------------------------------------------ */
/*
 * Shown once, above the bar, the first time someone reads a page. Same rule as the toast: it is
 * absolutely positioned out of flow, so appearing and disappearing never resizes the bar.
 */
.tips {
  box-sizing: border-box;
  width: min(420px, 100%);
  padding: 14px 16px 12px;
  border-radius: 14px;
  background: var(--bar-solid); color: var(--bar-fg);
  border: 1px solid var(--bar-border);
  box-shadow: var(--bar-shadow);
  font: var(--font);
  animation: aloud-rise 160ms ease-out;
}
.tips[hidden] { display: none; }
.tips h2 {
  all: unset; display: block;
  font: inherit; font-size: 13.5px; font-weight: 700; margin-bottom: 8px;
}
.tips ul { all: unset; display: flex; flex-direction: column; gap: 7px; margin-bottom: 12px; }
.tips li { all: unset; display: flex; align-items: flex-start; gap: 9px; font-size: 12.5px; }
.tips .key {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 20px; padding: 0 5px; border-radius: 6px;
  background: var(--bar-hover); color: var(--bar-fg);
  font-size: 11px; font-weight: 600;
}
.tips .tip-text { color: var(--bar-muted); }
.tips .tip-text b { color: var(--bar-fg); font-weight: 600; }
.tips .tips-actions { display: flex; align-items: center; gap: 8px; }
.tips button {
  all: unset; box-sizing: border-box; cursor: pointer;
  padding: 6px 12px; border-radius: 8px; font: inherit; font-size: 12.5px;
  transition: background 120ms ease;
}
.tips button.ok { background: var(--accent); color: var(--accent-on); font-weight: 650; }
.tips button.ok:hover { background: var(--accent-hi); }
.tips button.link { color: var(--bar-muted); }
.tips button.link:hover { background: var(--bar-hover); color: var(--bar-fg); }
.tips button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

@keyframes aloud-spin { to { transform: rotate(360deg); } }
@keyframes aloud-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(255,214,10,.6); }
  50% { box-shadow: 0 0 0 7px rgba(255,214,10,0); }
}
@keyframes aloud-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ---- narrow viewports and touch ---------------------------------------- */
/*
 * The controls wrap onto two rows: transport and options on top, the progress scrubber and
 * counter below, where the scrubber gets the full width it needs to be draggable with a thumb.
 * The voice picker is dropped here — a native <select> of 171 options is unusable on a phone,
 * and the gear button opens the settings page where voices are chosen properly.
 */
@media (max-width: ${NARROW_BREAKPOINT_PX}px) {
  .dock {
    width: calc(100vw - 12px);
    bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    gap: 6px;
  }
  .bar {
    flex-wrap: wrap;
    gap: 6px 6px;
    padding: 9px 10px;
  }
  button { width: 40px; height: 40px; }
  .play { width: 46px; height: 46px; }
  .play .btn-spin { width: 20px; height: 20px; }
  select { padding: 8px 10px; max-width: none; }
  /*
   * Three rows, in the order they are used: transport and speed, then the scrubber with its
   * counter, then the secondary buttons. Eight controls and a speed picker do not fit across a
   * phone, and a predictable three-row bar is far better than a two-row one that reshuffles
   * itself as the sentence counter grows a digit.
   */
  .progress { order: 10; flex: 1 1 60%; height: 22px; }
  .progress > .track { height: 10px; border-radius: 5px; }
  .progress > .track > i { border-radius: 5px; }
  .progress > .knob { width: 16px; height: 16px; margin-left: -8px; transform: translateY(-50%) scale(1); }
  .count { order: 11; }
  .side { order: 12; flex: 1 1 100%; justify-content: space-between; }
  /* The voice stays in the first row, by its face: on a phone it is the only way to change it. */
  .voice { height: 40px; padding: 0 6px 0 4px; }
  .voice .voice-name { display: none; }
  .sep { display: none; }
  .spacer { flex: 1 1 auto; }
}

/*
 * Coarse pointers (touchscreens) get the same generous targets even on a wide screen — a tablet
 * in landscape is still being tapped, not clicked.
 */
@media (pointer: coarse) {
  button { width: 40px; height: 40px; }
  .play { width: 46px; height: 46px; }
  .progress > .track { height: 10px; border-radius: 5px; }
  .progress > .track > i { border-radius: 5px; }
  .progress > .knob { transform: translateY(-50%) scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .spinner, .play .btn-spin { animation-duration: 2.4s; }
  .play.attn { animation: none; box-shadow: 0 0 0 3px rgba(255,214,10,.5); }
  .tips, .pop-menu { animation: none; }
  button, select, .progress > .track, .progress > .knob { transition: none; }
}
`;
