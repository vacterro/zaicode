export interface BlankClick {
  x: number;
  y: number;
  at: number;
}

export function trackBlankClick(previous: BlankClick[], click: BlankClick): BlankClick[] {
  const recent = previous.filter((item) => click.at - item.at <= 6);
  const last = recent.at(-1);
  if (last && Math.hypot(last.x - click.x, last.y - click.y) < 40) return recent;
  return [...recent.slice(-4), click];
}

const CONTROLS =
  'button,a,input,textarea,select,label,canvas,[contenteditable],[role="button"],[role="dialog"],[role="menu"],[role="listbox"],[data-testid="v4-composer"],[data-v4-draft-greeting]';

export function isBlankDraftClick(event: PointerEvent, pane: HTMLElement): boolean {
  if (document.hidden || pane.closest("[inert]") || pane.getClientRects().length === 0)
    return false;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !pane.contains(target)) return false;
  if (
    event.button !== 0 ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.shiftKey ||
    event.defaultPrevented
  )
    return false;
  if (
    target.closest(CONTROLS) ||
    document.querySelector(
      '[role="dialog"],[role="menu"],[data-zaicode-saipeggle],[data-zaicode-saiasui]',
    )
  )
    return false;
  if (window.getSelection()?.toString()) return false;
  // Only layout background counts. Text, icons and custom interactive regions do not.
  if (
    !/^(DIV|MAIN|SECTION)$/.test(target.tagName) ||
    target.closest('[tabindex]:not([tabindex="-1"])')
  )
    return false;
  return !Array.from(target.childNodes).some(
    (node) => node.nodeType === 3 && node.textContent?.trim(),
  );
}
