import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parents[2]
product = root / "zcode"
rel = "packages/ui/src/zaicode/ZaicodeWorkersPanel.tsx"
target = product / rel
current = target.read_bytes()
assert b'data-zaicode-workers-panel-collapsed' in current
(root / '.saipen/evidence/T-209-formatted-first.tsx').write_bytes(current)
text = subprocess.check_output(['git', 'show', '95d91ae6baef7b4d58dd5a1daaf73c93be933f7f:' + rel], cwd=product).decode('utf-8')
def change(old, new):
    global text
    assert text.count(old) == 1, repr(old)
    text = text.replace(old, new)
change('  ChevronDown,\n', '  ChevronDown,\n  ChevronUp,\n')
change('  zaicodeEffectiveSplit,\n', '  zaicodeEffectiveSplit,\n  zaicodeWorkersDisplayDock,\n')
change('  hideZaicodeWorkersPanel,\n', '')
change('  const dock = prefs.panelDock;\n', '  const dock = prefs.panelDock;\n  const collapsed = prefs.panelCollapsed;\n  const displayDock = zaicodeWorkersDisplayDock(dock, collapsed);\n')
change('.filter((worker) => (layout === "tabs" ? worker.id === active?.id : solo ? worker.id === solo.id : true))', '.filter((worker) => !collapsed && (layout === "tabs" ? worker.id === active?.id : solo ? worker.id === solo.id : true))')
change('  const frameStyle = vertical\n', '  const frameStyle = collapsed\n    ? { height: 24, minHeight: 24, maxHeight: 24 }\n    : vertical\n')
change('        ZAICODE_DOCK_BORDER[dock],', '        ZAICODE_DOCK_BORDER[displayDock],')
change('      data-zaicode-workers-panel-dock={dock}\n', '      data-zaicode-workers-panel-dock={dock}\n      data-zaicode-workers-panel-collapsed={String(collapsed)}\n')
change('      <div\n        role="separator"', '      {!collapsed ? <div\n        role="separator"')
change('        onDoubleClick={() => setZaicodeWorkersPanelMaximized(!state.panelMaximized)}\n      />', '        onDoubleClick={() => setZaicodeWorkersPanelMaximized(!state.panelMaximized)}\n      /> : null}')
change('                    onClick={() => (layout === "split" && state.soloId ? soloZaicodeWorker(worker.id) : raiseZaicodeWorker(worker.id))}', '''                    onClick={() => {
                      if (collapsed) useZaicodeWorkerPrefs.getState().update({ panelCollapsed: false });
                      if (layout === "split" && state.soloId) soloZaicodeWorker(worker.id);
                      else raiseZaicodeWorker(worker.id);
                    }}''')
change('            onClick={() => setZaicodeWorkersPanelMaximized(!state.panelMaximized)}', '''            onClick={() => {
              if (collapsed) useZaicodeWorkerPrefs.getState().update({ panelCollapsed: false });
              setZaicodeWorkersPanelMaximized(!state.panelMaximized);
            }}''')
change('''          <ZaicodeWorkerIconButton title="Hide the panel (workers keep running)" onClick={hideZaicodeWorkersPanel}>
            <ChevronDown className="size-3.5" />''', '''          <ZaicodeWorkerIconButton
            title={collapsed ? "Expand the panel (same workers)" : "Collapse the panel (workers keep running)"}
            pressed={collapsed}
            onClick={() => useZaicodeWorkerPrefs.getState().update({ panelCollapsed: !collapsed })}
          >
            {collapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}''')
change('      <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-hidden" data-zaicode-workers-body>', '''      {/* 收起仅隐藏正文，保留 TerminalSession/PTY 身份；不能把标题点击变成整个终端子树卸载。 */}
      <div ref={bodyRef} className={cn("relative min-h-0 flex-1 overflow-hidden", collapsed && "hidden")} data-zaicode-workers-body>''')
assert target.read_bytes() == current, 'Concurrent writer changed the owned panel'
target.write_bytes(text.encode('utf-8'))
print(f'Preserved original formatting: {len(text.splitlines())} physical lines')
