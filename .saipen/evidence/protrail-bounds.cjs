const { app, BrowserWindow, screen } = require('electron');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'protrail-bounds-')));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});
setTimeout(() => app.exit(2), 15000).unref();
app.whenReady().then(async () => {
  for (const type of [undefined, 'toolbar']) {
    const movable = false;
    for (const display of screen.getAllDisplays()) {
      const win = new BrowserWindow({ ...display.bounds, type, show: false, frame: false,
        transparent: true, backgroundColor: '#00000000', hasShadow: false,
        resizable: false, movable, minimizable: false, maximizable: false,
        fullscreenable: false, focusable: false, skipTaskbar: true,
        alwaysOnTop: true, enableLargerThanScreen: true,
        webPreferences: { sandbox: true, backgroundThrottling: false } });
      win.setIgnoreMouseEvents(true);
      win.setAlwaysOnTop(true, 'screen-saver');
      const created = win.getBounds();
      await win.loadURL('data:text/html,<style>html{background:transparent}</style>');
      win.setBounds(display.bounds);
      const assigned = win.getBounds();
      win.showInactive();
      const justShown = win.getBounds();
      win.setBounds(display.bounds);
      const placedAfterShow = win.getBounds();
      await new Promise(resolve => setTimeout(resolve, 1000));
      console.log(JSON.stringify({ type: type ?? 'normal', requested: display.bounds, created, assigned, justShown, placedAfterShow, shown: win.getBounds() }));
      if (type === 'toolbar') require('node:assert/strict').deepEqual(win.getBounds(), display.bounds);
      win.destroy();
    }
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
