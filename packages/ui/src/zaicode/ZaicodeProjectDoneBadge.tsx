import type { ZaicodeProjectDoneMark } from "./zaicodeProjectDone.js";

/**
 * The row's special DONE mark (SRC-062): a check in the palette's success
 * colour when SAIPEN says the project is done and its board is clean; with
 * "A3" beside it when an audit wave would look at something new. A click on
 * the offer opens the audit centre on this project (nothing is dispatched).
 */
export function ZaicodeProjectDoneBadge({
  mark,
  onOfferA3,
}: {
  mark: ZaicodeProjectDoneMark;
  onOfferA3: () => void;
}) {
  return (
    <button
      type="button"
      className="flex shrink-0 items-center gap-0.5 border border-[var(--color-success)] px-0.5 text-[10px] leading-3 text-[var(--color-success)] hover:bg-hover disabled:cursor-default"
      title={mark.title}
      aria-label={mark.offerA3 ? "Done and clean: plan an A3 audit" : "Done and clean"}
      disabled={!mark.offerA3}
      data-zaicode-done-mark={mark.offerA3 ? "offer-a3" : "clean"}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (mark.offerA3) onOfferA3();
      }}
    >
      <span aria-hidden="true">✔</span>
      {mark.offerA3 ? <span className="text-[var(--zaicode-highlight,var(--color-warning))]">A3</span> : null}
    </button>
  );
}
