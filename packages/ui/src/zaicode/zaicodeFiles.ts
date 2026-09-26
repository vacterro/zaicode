/**
 * Settings files (SRC-048): export writes a JSON file through the browser
 * download path (Electron asks where to save it), import reads one the
 * operator picked. Shared by Highlights & motion presets and profiles.
 */

/** Starts a download of `text` as `fileName`. */
export function downloadZaicodeTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Opens a file picker for one JSON file and hands its text over; nothing happens on cancel. */
export function pickZaicodeJsonFile(onText: (text: string) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void file.text().then(onText);
  };
  input.click();
}

/** A file name from a free-text name: letters, digits, dot, dash. */
export function zaicodeFileStem(name: string, fallback: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;
}
