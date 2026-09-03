/**
 * Styles for the in-page control bar, scoped to its Shadow DOM.
 *
 * Two things drive the layout:
 *
 *  - **The bar must not move when text changes.** Its width is a function of the viewport only,
 *    and transient status ("Loading…", "Buffering…", an error) is shown in a pill floated above
 *    the bar rather than inside it, so the buttons never shift under the pointer.
 *  - **It has to work with a thumb.** Below the narrow breakpoint the controls wrap onto two
 *    rows, hit targets grow to the 44px normally recommended for touch, and the bar sits above
 *    the phone's home indicator via `env(safe-area-inset-bottom)`.
 *
 * `:host { all: initial }` plus the closed shadow root means the host page's CSS cannot reach
 * anything here, and nothing here escapes.
 */

/** Below this viewport width the bar switches to its two-row touch layout. */
export const NARROW_BREAKPOINT_PX = 560;

export const CONTROL_BAR_CSS = `
:host { all: initial; }

.bar {
  position: fixed; left: 50%; bottom: calc(20px + env(safe-area-inset-bottom, 0px));
  transform: translateX(-50%);
  z-index: 2147483647;
  box-sizing: border-box;
  width: min(760px, calc(100vw - 20px));
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-radius: 14px;
  background: #1c1c22; color: #f2f2f5;
  font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 8px 30px rgba(0,0,0,.35);
}
.bar:focus-visible { outline: 2px solid #ffd60a; outline-offset: 2px; }

button {
  all: unset; box-sizing: border-box; flex: 0 0 auto;
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 8px; color: inherit;
}
button:hover { background: rgba(255,255,255,.12); }
button:focus-visible { outline: 2px solid #ffd60a; outline-offset: 1px; }
button[disabled] { opacity: .4; cursor: default; }

.play { width: 34px; height: 34px; background: #ffd60a; color: #1c1c22; font-weight: 700; }
.play:hover { background: #ffe14d; }
.play.attn { animation: aloud-pulse 1.4s ease-in-out infinite; }
.play.loading { cursor: progress; }
.play.loading:hover { background: #ffd60a; }
.play .btn-spin {
  width: 16px; height: 16px; box-sizing: border-box;
  border: 2px solid rgba(28,28,34,.3); border-top-color: #1c1c22;
  border-radius: 50%; animation: aloud-spin .8s linear infinite;
}

.tap.on { background: #ffd60a; color: #1c1c22; }
.tap.on:hover { background: #ffe14d; }

.progress {
  flex: 1 1 auto; min-width: 40px; height: 6px; border-radius: 3px;
  background: rgba(255,255,255,.18); cursor: pointer; position: relative;
}
.progress > i {
  position: absolute; left: 0; top: 0; bottom: 0;
  border-radius: 3px; background: #ffd60a; width: 0%;
}
.count { flex: 0 0 auto; font-variant-numeric: tabular-nums; opacity: .7; white-space: nowrap; }

select {
  all: unset; box-sizing: border-box; flex: 0 0 auto;
  cursor: pointer; padding: 3px 6px; border-radius: 7px;
  background: rgba(255,255,255,.12); color: inherit; font: inherit;
  max-width: 120px; text-overflow: ellipsis;
}
select:focus-visible { outline: 2px solid #ffd60a; }
.voice[hidden] { display: none; }

.toast {
  position: absolute; left: 4px; right: 4px; bottom: calc(100% + 8px);
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 6px 12px; border-radius: 10px;
  background: #1c1c22; color: #f2f2f5;
  font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 6px 22px rgba(0,0,0,.3);
  text-align: center;
}
.toast[hidden] { display: none; }
.toast.err { color: #ff8a8a; }

.spinner {
  width: 12px; height: 12px; flex: 0 0 auto;
  border: 2px solid rgba(255,255,255,.3); border-top-color: #ffd60a;
  border-radius: 50%; animation: aloud-spin .8s linear infinite;
}

@keyframes aloud-spin { to { transform: rotate(360deg); } }
@keyframes aloud-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(255,214,10,.6); }
  50% { box-shadow: 0 0 0 6px rgba(255,214,10,0); }
}

/* ---- narrow viewports and touch ---------------------------------------- */
/*
 * The controls wrap onto two rows: transport and options on top, the progress scrubber and
 * counter below, where the scrubber gets the full width it needs to be draggable with a thumb.
 * The voice picker is dropped here — a native <select> of 175 options is unusable on a phone,
 * and the gear button opens the settings page where voices are chosen properly.
 */
@media (max-width: ${NARROW_BREAKPOINT_PX}px) {
  .bar {
    width: calc(100vw - 12px);
    bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    flex-wrap: wrap;
    gap: 6px 8px;
    padding: 10px;
  }
  button { width: 40px; height: 40px; }
  .play { width: 46px; height: 46px; }
  .play .btn-spin { width: 20px; height: 20px; }
  select { padding: 8px 10px; max-width: none; }
  /* Push the scrubber and its counter onto a second row. */
  .progress { order: 10; flex: 1 1 100%; height: 12px; border-radius: 6px; }
  .progress > i { border-radius: 6px; }
  .count { order: 11; }
  .voice { display: none; }
  .spacer { flex: 1 1 auto; }
}

/*
 * Coarse pointers (touchscreens) get the same generous targets even on a wide screen — a tablet
 * in landscape is still being tapped, not clicked.
 */
@media (pointer: coarse) {
  button { width: 40px; height: 40px; }
  .play { width: 46px; height: 46px; }
  .progress { height: 12px; border-radius: 6px; }
  .progress > i { border-radius: 6px; }
}

@media (prefers-color-scheme: light) {
  .bar, .toast {
    background: #fff; color: #1c1c22;
    box-shadow: 0 8px 30px rgba(0,0,0,.18);
    border: 1px solid rgba(0,0,0,.08);
  }
  button:hover { background: rgba(0,0,0,.06); }
  .progress { background: rgba(0,0,0,.12); }
  select { background: rgba(0,0,0,.06); }
}

@media (prefers-reduced-motion: reduce) {
  .spinner, .play .btn-spin { animation-duration: 2s; }
  .play.attn { animation: none; box-shadow: 0 0 0 3px rgba(255,214,10,.5); }
}
`;
