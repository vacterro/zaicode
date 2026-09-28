import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { protrailDefaults } from "../protrail/protrailModel.js";
import { setZaicodeProtrailForced } from "../protrail/zaicodeProtrailForce.js";
import { useZaicodeProtrail } from "../protrail/zaicodeProtrailStore.js";
import { advanceRun, applyLiveConfig, createRun, hitTarget } from "./saiasuiEngine.js";
import type { SaiasuiConfig, SaiasuiPreset } from "./saiasuiConfig.js";
import { detectSaiasuiPreset, saiasuiPresetConfig, SAIASUI_DEFAULTS } from "./saiasuiConfig.js";
import { isolateSaiasui } from "./saiasuiIsolation.js";
import { createSaiasuiSound } from "./saiasuiSound.js";
import { SaiasuiSettingsPanel } from "./SaiasuiSettingsPanel.js";
import { useSaiasui } from "./saiasuiStore.js";
import { SaiasuiTarget } from "./SaiasuiTarget.js";

export function SaiasuiGame({
  config: initialConfig,
  onExit,
}: {
  config: SaiasuiConfig;
  onExit: () => void;
}) {
  const { intl } = useZCodeIntl();
  const root = useRef<HTMLDivElement>(null);
  const [run] = useState(() =>
    createRun(
      globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      initialConfig,
    ),
  );
  const [config, setConfig] = useState(initialConfig);
  const [paused, setPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState<Record<string, boolean>>({});
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [reducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [, redraw] = useState(0);
  const sound = useRef<ReturnType<typeof createSaiasuiSound> | null>(null);
  const best = useSaiasui((state) => state.best[run.mode]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused || settingsOpen;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;

  useLayoutEffect(() => (root.current ? isolateSaiasui(root.current) : undefined), []);

  // ProTrail core invariant (T-105): force the in-window trail ON for the whole
  // game, without touching the user's saved preference. Restored on unmount.
  useEffect(() => {
    const saved = useZaicodeProtrail.getState().config;
    const forced = { ...(saved ?? protrailDefaults()), enabled: true, everywhere: false, followCalm: false };
    setZaicodeProtrailForced(forced);
    return () => setZaicodeProtrailForced(null);
  }, []);

  useEffect(() => {
    const audio = createSaiasuiSound();
    sound.current = audio;
    let frame = 0;
    let previous = performance.now();
    let published = 0;
    let lastFeedback: string | null = null;
    const tick = (now: number) => {
      const dt = (now - previous) / 1000;
      previous = now;
      if (!pausedRef.current) advanceRun(run, dt);
      if (run.feedback && run.feedback.text === "MISS" && lastFeedback !== "MISS")
        sound.current?.play("miss", run.config);
      lastFeedback = run.feedback?.until && run.feedback.until > run.elapsed ? run.feedback.text : null;
      if (now - published >= 30 || run.over) {
        redraw((n) => n + 1);
        published = now;
      }
      if (!run.over) frame = requestAnimationFrame(tick);
      else {
        if (!run.tainted) useSaiasui.getState().record(run.mode, run.score, run.maxCombo);
        sound.current?.play("gameover", run.config);
      }
    };
    frame = requestAnimationFrame(tick);
    const resize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (settingsOpenRef.current) {
          setSettingsOpen(false);
          setPaused(false);
        } else onExit();
      }
      // 应用热键不能在游戏下修改草稿；原生 Tab/按钮默认动作仍可用。
      event.stopImmediatePropagation();
    };
    window.addEventListener("resize", resize);
    window.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(frame);
      audio.close();
      sound.current = null;
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", key, true);
      if (!run.over && !run.tainted) useSaiasui.getState().record(run.mode, run.score, run.maxCombo);
    };
  }, [run, onExit]);

  const applyPatch = (patch: Partial<SaiasuiConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch, preset: "custom" as SaiasuiPreset };
      const resolved = { ...next, preset: detectSaiasuiPreset(next) };
      applyLiveConfig(run, resolved);
      // Persist the operator's choices to the store so they outlast the run.
      useSaiasui.getState().configure(resolved);
      return resolved;
    });
  };
  const applyPreset = (preset: SaiasuiPreset) => {
    const next = preset === "custom" ? { ...config, preset } : saiasuiPresetConfig(preset);
    setConfig(next);
    applyLiveConfig(run, next);
    useSaiasui.getState().applyPreset(preset);
  };
  const resetAll = () => {
    const next = { ...SAIASUI_DEFAULTS };
    setConfig(next);
    applyLiveConfig(run, next);
    useSaiasui.getState().resetAll();
  };

  const hit = (id: number | null) => {
    if (pausedRef.current) return;
    const points = hitTarget(run, id);
    if (points)
      sound.current?.play(
        points === 500 ||
          run.feedback?.text === "GOD" ||
          run.feedback?.text === "FULL" ||
          run.feedback?.text === "SLOW"
          ? "special"
          : "hit",
        run.config,
      );
    redraw((n) => n + 1);
  };
  const openSettings = () => {
    setSettingsOpen(true);
    setPaused(true);
  };
  const cover = Math.min(1, run.hits / 30);
  const c = config;
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="SAIASUI!"
      tabIndex={-1}
      data-zaicode-saiasui
      className="fixed inset-0 z-[10001] overflow-hidden text-foreground outline-none [app-region:no-drag]"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button === 0) {
          event.preventDefault();
          hit(null);
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPaste={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <style>{`[data-saiasui-target] { border-radius: 50% !important; transform: none !important; }
        [data-zaicode-saiasui] { font-family: inherit; }
        [data-saiasui-cover] { transition: none !important; }`}</style>
      <div
        data-saiasui-cover
        className="pointer-events-none absolute inset-0 bg-background"
        style={{ opacity: cover }}
      />
      {c.hudVisible ? (
        <header
          className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-background px-3 py-2 text-ui-sm"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <strong className="text-ui-lg">SAIASUI!</strong>
          {c.showScore ? (
            <span>
              {intl.formatMessage({ id: "saiasui.score" }, { score: run.score.toLocaleString() })}
            </span>
          ) : null}
          {c.showCombo ? (
            <span>
              {intl.formatMessage({ id: "saiasui.combo" }, { combo: run.combo, max: run.maxCombo })}
            </span>
          ) : null}
          {c.showScore ? (
            <span>
              {intl.formatMessage(
                { id: "saiasui.best" },
                { score: Math.max(best.score, run.score).toLocaleString() },
              )}
            </span>
          ) : null}
          <span>
            {Math.floor(run.elapsed / 60)}:{String(Math.floor(run.elapsed % 60)).padStart(2, "0")}
          </span>
          {run.tainted ? (
            <span className="text-warning" role="status">
              {intl.formatMessage({ id: "saiasui.tainted" })}
            </span>
          ) : null}
          <button
            className="ml-auto border border-border px-2 py-1"
            type="button"
            aria-label={intl.formatMessage({ id: "saiasui.settings" })}
            title={intl.formatMessage({ id: "saiasui.settings" })}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={openSettings}
          >
            ⚙
          </button>
          <button
            className="border border-border px-2 py-1"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onExit}
          >
            {intl.formatMessage({ id: "saiasui.exit" })}
          </button>
          {c.showHp && run.hpActive ? (
            <div className="flex w-full items-center gap-2 text-ui-xs">
              HP{" "}
              <div
                role="progressbar"
                aria-label={intl.formatMessage({ id: "saiasui.health" })}
                aria-valuemin={0}
                aria-valuemax={Math.round(c.maxHp)}
                aria-valuenow={Math.ceil(run.hp)}
                className="h-2 min-w-0 flex-1 border border-border bg-card"
              >
                <div className="h-full bg-success" style={{ width: `${(run.hp / c.maxHp) * 100}%` }} />
              </div>{" "}
              {Math.ceil(run.hp)}
            </div>
          ) : null}
        </header>
      ) : null}
      {!run.over &&
        [run.target, run.bonus].map(
          (target) =>
            target && (
              <SaiasuiTarget
                key={target.id}
                target={target}
                run={run}
                config={c}
                width={size.width}
                height={size.height}
                reducedMotion={reducedMotion}
                onHit={hit}
              />
            ),
        )}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-wrap justify-center gap-3 px-3 text-ui-sm">
        {run.godUntil > run.elapsed ? (
          <span className="bg-background px-2">GOD {Math.ceil(run.godUntil - run.elapsed)}s</span>
        ) : null}
        {run.slowUntil > run.elapsed ? (
          <span className="bg-background px-2">SLOW {Math.ceil(run.slowUntil - run.elapsed)}s</span>
        ) : null}
        {c.missFeedback && run.feedback && run.feedback.until > run.elapsed ? (
          <span className="bg-background px-2">{run.feedback.text}</span>
        ) : null}
        {c.showGrade && run.checkpoint ? (
          <span className="bg-background px-2" role="status">
            {intl.formatMessage(
              { id: "saiasui.segment" },
              {
                minutes: run.checkpoint.segment * 2,
                grade: run.checkpoint.grade,
                accuracy: (run.checkpoint.accuracy * 100).toFixed(1),
              },
            )}
          </span>
        ) : null}
      </div>
      {settingsOpen ? (
        <div
          className="absolute inset-0 z-[10002] flex items-start justify-center overflow-auto bg-background/80 p-6"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="w-full max-w-md border border-border bg-background p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-ui-lg">{intl.formatMessage({ id: "saiasui.settings" })}</h2>
              <button
                className="border border-border px-3 py-1"
                type="button"
                onClick={() => {
                  setSettingsOpen(false);
                  setPaused(false);
                }}
              >
                {intl.formatMessage({ id: "saiasui.resume" })}
              </button>
            </div>
            <SaiasuiSettingsPanel
              config={c}
              onChange={applyPatch}
              onPreset={applyPreset}
              onReset={resetAll}
              open={groupsOpen}
              onToggle={(id, next) => setGroupsOpen((prev) => ({ ...prev, [id]: next }))}
            />
          </div>
        </div>
      ) : null}
      {run.over ? (
        <div
          className="absolute inset-0 flex items-center justify-center"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div
            className="max-w-full border border-border bg-background p-6 text-ui-base"
            role="status"
          >
            <h2 className="text-ui-lg">{intl.formatMessage({ id: "saiasui.complete" })}</h2>
            <p className="my-3">
              {intl.formatMessage(
                { id: "saiasui.result" },
                { score: run.score.toLocaleString(), combo: run.maxCombo, hits: run.hits },
              )}
            </p>
            <p className="text-ui-sm">{intl.formatMessage({ id: "saiasui.retryHint" })}</p>
            <details className="mt-3 text-ui-xs text-foreground-subtle">
              <summary>{intl.formatMessage({ id: "saiasui.details" })}</summary>
              <p className="mt-1">
                {intl.formatMessage({ id: "saiasui.seed" }, { mode: run.mode, seed: run.seed.slice(0, 8) })}
                {run.tainted ? ` · ${intl.formatMessage({ id: "saiasui.tainted" })}` : ""}
              </p>
              <button
                className="mt-1 border border-border px-2 py-1"
                type="button"
                onClick={() => void navigator.clipboard?.writeText(run.seed).catch(() => undefined)}
              >
                {intl.formatMessage({ id: "saiasui.copySeed" })}
              </button>
            </details>
            <button className="mt-4 border border-border px-3 py-1" type="button" onClick={onExit}>
              {intl.formatMessage({ id: "saiasui.return" })}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
