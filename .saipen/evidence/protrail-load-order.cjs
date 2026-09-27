// Bounded, hidden Electron probe; never opens the product profile or application.
const { app, BrowserWindow, screen } = require("electron");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

app.setPath("userData", mkdtempSync(join(tmpdir(), "zaicode-protrail-load-")));
const watchdog = setTimeout(() => app.exit(2), 15000);
app.whenReady().then(async () => {
  console.log(JSON.stringify({ electron: process.versions.electron, displays: screen.getAllDisplays().map(({ bounds, scaleFactor }) => ({ bounds, scaleFactor })) }));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  for (const name of ["dom-ready", "did-finish-load", "did-stop-loading"]) {
    win.webContents.on(name, () => {
      console.log(JSON.stringify({ event: name, loading: win.webContents.isLoading() }));
      if (name === "did-stop-loading") {
        clearTimeout(watchdog);
        win.destroy();
        app.exit(0);
      }
    });
  }
  await win.loadURL('data:text/html,<html><body><script type="module">globalThis.overlayReady = true;</script></body></html>');
}).catch((error) => { console.error(error); app.exit(1); });
