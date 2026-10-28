/** Keep the app mounted, preserve pre-existing inert states, restore on every exit. */
export function isolateSaiasui(root: HTMLElement): () => void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const saved = new Map<HTMLElement, boolean>();
  const isolate = () => {
    for (const child of Array.from(document.body.children)) {
      if (
        !(child instanceof HTMLElement) ||
        child === root ||
        child.contains(root) ||
        // ProTrail's click-through canvas must keep drawing over the game
        // (T-105 core invariant); it has no focusable content, so leaving it
        // un-inerted changes nothing about the modal's input isolation.
        child.matches("[data-zaicode-protrail]") ||
        saved.has(child)
      )
        continue;
      saved.set(child, child.inert);
      child.inert = true;
    }
  };
  isolate();
  const observer = new MutationObserver(isolate);
  observer.observe(document.body, { childList: true });
  root.focus({ preventScroll: true });
  return () => {
    observer.disconnect();
    const restoreFocus =
      root.contains(document.activeElement) || document.activeElement === document.body;
    for (const [element, inert] of saved) element.inert = inert;
    if (
      restoreFocus &&
      active?.isConnected &&
      active.getClientRects().length &&
      !active.closest("[inert]")
    )
      active.focus({ preventScroll: true });
  };
}
