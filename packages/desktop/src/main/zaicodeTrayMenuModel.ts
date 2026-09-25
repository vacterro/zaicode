/**
 * ZAICODE's tray menu, the pure half: entries, the popup page and where it
 * opens. The native Windows menu is white, ignores the product palette and
 * carried upstream housekeeping ("Clear all data", update checks); ZAICODE
 * draws this page instead (Golden Default tokens, square bevels, no motion).
 * The page is a sandboxed data: document without preload or IPC: a pick sets
 * the document title ("pick:<id>"), which main reads and cancels.
 */

export type ZaicodeTrayMenuEntry = { id: string; label: string } | "separator";

export const ZAICODE_TRAY_MENU_WIDTH = 190;
const ITEM_HEIGHT = 22;
const SEPARATOR_HEIGHT = 8;
/** 2px bevel on each side plus 2px inner padding top and bottom. */
const FRAME = 8;
const PICK = "pick:";

export function zaicodeTrayMenuHeight(entries: readonly ZaicodeTrayMenuEntry[]): number {
  return entries.reduce((sum, entry) => sum + (entry === "separator" ? SEPARATOR_HEIGHT : ITEM_HEIGHT), FRAME);
}

export interface ZaicodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the popup goes: it opens up and to the left of the cursor (the tray
 * sits in the bottom-right corner), and is pushed back inside the work area
 * whenever the taskbar lives on another edge.
 */
export function placeZaicodeTrayMenu(
  cursor: { x: number; y: number },
  workArea: ZaicodeRect,
  size: { width: number; height: number },
): { x: number; y: number } {
  const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)));
  const right = workArea.x + workArea.width - size.width;
  const bottom = workArea.y + workArea.height - size.height;
  const x = cursor.x - size.width >= workArea.x ? cursor.x - size.width : cursor.x;
  const y = cursor.y - size.height >= workArea.y ? cursor.y - size.height : cursor.y;
  return { x: clamp(x, workArea.x, right), y: clamp(y, workArea.y, bottom) };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The whole popup page: Golden Default tokens (saipen UI.md), nothing else. */
export function buildZaicodeTrayMenuHtml(entries: readonly ZaicodeTrayMenuEntry[]): string {
  const body = entries
    .map((entry) =>
      entry === "separator"
        ? '<div class="sep" role="separator"></div>'
        : `<a role="menuitem" href="#" data-id="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</a>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>ZAICODE</title><style>
*{box-sizing:border-box;margin:0;border-radius:0;transition:none;animation:none;box-shadow:none;
font-family:Verdana,sans-serif;-webkit-font-smoothing:none;text-rendering:optimizeSpeed}
html,body{height:100%;overflow:hidden;background:#332E22;color:#D4C89A;font-size:11px;user-select:none;cursor:default}
body{border:2px solid;border-color:#75663D #100E08 #100E08 #75663D;padding:2px 0}
a{display:block;height:${ITEM_HEIGHT}px;line-height:${ITEM_HEIGHT}px;padding:0 14px;color:#D4C89A;text-decoration:none;white-space:nowrap;outline:none}
a:hover,a:focus{background:#453D30;color:#F0D060}
.sep{height:${SEPARATOR_HEIGHT}px;padding:3px 4px}
.sep::before{content:"";display:block;border-top:1px solid #100E08;border-bottom:1px solid #75663D}
</style></head><body role="menu" aria-label="ZAICODE">${body}<script>
const items=[...document.querySelectorAll('a')];
const pick=(id)=>{document.title='${PICK}'+id;};
items.forEach((item)=>item.addEventListener('click',(event)=>{event.preventDefault();pick(item.dataset.id);}));
addEventListener('keydown',(event)=>{
  const at=items.indexOf(document.activeElement);
  if(event.key==='Escape'){pick('close');}
  else if(event.key==='ArrowDown'){items[(at+1)%items.length].focus();event.preventDefault();}
  else if(event.key==='ArrowUp'){items[(at-1+items.length)%items.length].focus();event.preventDefault();}
});
</script></body></html>`;
}

/** Title `pick:<id>` -> "<id>"; `pick:close` -> "" (just close); any other title -> null. */
export function readZaicodeTrayMenuPick(title: string): string | null {
  if (!title.startsWith(PICK)) return null;
  const id = title.slice(PICK.length);
  return id === "close" ? "" : id;
}

/** The operator's own destinations only -- no "Clear all data", update check or About. */
export const ZAICODE_TRAY_MENU: readonly ZaicodeTrayMenuEntry[] = [
  { id: "open", label: "Open ZAICODE" },
  { id: "home", label: "SAIHOME" },
  { id: "newTask", label: "New task" },
  "separator",
  { id: "workers", label: "WORKERS" },
  { id: "timers", label: "Timers" },
  { id: "settings", label: "Settings" },
  "separator",
  { id: "quit", label: "Quit ZAICODE" },
];
