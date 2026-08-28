/**
 * Fatal error surface (harden pass): the last-resort notice for failures
 * that kill the application itself — a boot failure in main.ts, a dead
 * render loop in app.ts, an unhandled background rejection. Everything
 * recoverable in-product already has its own state (validation issues in
 * the panel, the optimizer's 'failed' phase, the benchmark's status line);
 * this is the layer under all of them, so a cold visitor never meets a
 * silently blank or silently frozen page.
 *
 * Pure half (`fatalErrorMessage`) is unit-tested in node like every other
 * model; the DOM half is thin and IDEMPOTENT — the first call wins, later
 * calls are no-ops (one honest notice, not a stack of panics; a dead loop
 * must not re-announce itself every frame).
 *
 * Styling lives in index.html (`.boot-error`) in the same instrument voice
 * as the issues list: panel surface, hairline border, Error-red heading,
 * no shadows, no transitions (the design doctrine). The copy names the
 * problem AND the recovery — reload, the only reset a session-only app has.
 */

/** Longest error detail rendered before truncation (layout guard — an
 * unbounded message must not push the notice off the viewport). */
export const MAX_DETAIL_LENGTH = 300;

/**
 * Human-readable text for an unknown-caught error (pure): Error → message
 * (name when the message is empty), string → itself, anything else →
 * String(). Truncated to `MAX_DETAIL_LENGTH` with an ellipsis.
 */
export function fatalErrorMessage(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    text = error.message.length > 0 ? error.message : error.name;
  } else if (typeof error === 'string') {
    text = error;
  } else {
    text = String(error);
  }
  if (text.length > MAX_DETAIL_LENGTH) {
    text = `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…`;
  }
  return text;
}

let shown = false;

/**
 * Show the fatal notice (idempotent; first call wins). `context` names what
 * failed ("the application failed to start", "the simulation loop failed");
 * the notice carries the technical message and a Reload button.
 */
export function showFatalError(error: unknown, context: string): void {
  if (shown) return;
  shown = true;
  const body = document.body;
  if (body === null) return; // nothing to render into — nothing more to do

  const notice = document.createElement('div');
  notice.className = 'boot-error';
  notice.setAttribute('role', 'alert');

  const heading = document.createElement('strong');
  heading.textContent = `Simulation stopped — ${context}.`;

  const detail = document.createElement('span');
  detail.className = 'boot-error-detail';
  detail.textContent = fatalErrorMessage(error);

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.addEventListener('click', () => window.location.reload());

  notice.append(heading, detail, reload);
  body.append(notice);
}
