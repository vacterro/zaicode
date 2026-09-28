import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { advanceRun, createRun, hitTarget } from "./saiasuiEngine.js";
import { isolateSaiasui } from "./saiasuiIsolation.js";
import { createSaiasuiSound } from "./saiasuiSound.js";
import { useSaiasui, type SaiasuiSettings } from "./saiasuiStore.js";
import { SaiasuiTarget } from "./SaiasuiTarget.js";

export function SaiasuiGame({
  settings,
  onExit,
}: {
  settings: SaiasuiSettings;
  onExit: () => void;
}) {
  const { intl } = useZCodeIntl();
  const root = useRef<HTMLDivElement>(null);
  const [run] = useState(() =>
    createRun(
      globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      settings.pacing,
    ),
  );
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [reducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [, redraw] = useState(0);
  const sound = useRef<ReturnType<typeof createSaiasuiSound> | null>(null);
  const best = useSaiasui((state) => state.best[run.mode]);

  useLayoutEffect(() => (root.current ? isolateSaiasui(root.current) : undefined), []);
  useEffect(() => {
    const audio = createSaiasuiSound();
    sound.current = audio;
    let frame = 0;
    let previous = performance.now();
    let published = 0;
    const tick = (now: number) => {
      advanceRun(run, (now - previous) / 1000);
      previous = now;
      if (now - published >= 30 || run.over) {
        redraw((n) => n + 1);
        published = now;
      }
      if (!run.over) frame = requestAnimationFrame(tick);
      else useSaiasui.getState().record(run.mode, run.score, run.maxCombo);
    };
    frame = requestAnimationFrame(tick);
    const resize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onExit();
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
      useSaiasui.getState().record(run.mode, run.score, run.maxCombo);
    };
  }, [run, onExit]);

  const hit = (id: number | null) => {
    const points = hitTarget(run, id);
    if (points)
      sound.current?.hit(
        useSaiasui.getState().settings.sound,
        points === 500 ||
          run.feedback?.text === "GOD" ||
          run.feedback?.text === "FULL" ||
          run.feedback?.text === "SLOW",
      );
    redraw((n) => n + 1);
  };
  const cover = Math.min(1, run.hits / 30);
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
      <header
        className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-background px-3 py-2 text-ui-sm"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <strong className="text-ui-lg">SAIASUI!</strong>
        <span>
          {intl.formatMessage({ id: "saiasui.score" }, { score: run.score.toLocaleString() })}
        </span>
        <span>
          {intl.formatMessage({ id: "saiasui.combo" }, { combo: run.combo, max: run.maxCombo })}
        </span>
        <span>
          {intl.formatMessage(
            { id: "saiasui.best" },
            { score: Math.max(best.score, run.score).toLocaleString() },
          )}
        </span>
        <span>
          {Math.floor(run.elapsed / 60)}:{String(Math.floor(run.elapsed % 60)).padStart(2, "0")}
        </span>
        <button className="ml-auto border border-border px-2 py-1" type="button" onClick={onExit}>
          {intl.formatMessage({ id: "saiasui.exit" })}
        </button>
        {run.hpActive ? (
          <div className="flex w-full items-center gap-2 text-ui-xs">
            HP{" "}
            <div
              role="progressbar"
              aria-label={intl.formatMessage({ id: "saiasui.health" })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.ceil(run.hp)}
              className="h-2 min-w-0 flex-1 border border-border bg-card"
            >
              <div className="h-full bg-success" style={{ width: `${run.hp}%` }} />
            </div>{" "}
            {Math.ceil(run.hp)}
          </div>
        ) : null}
      </header>
      {!run.over &&
        [run.target, run.bonus].map(
          (target) =>
            target && (
              <SaiasuiTarget
                key={target.id}
                target={target}
                now={run.elapsed}
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
        {run.feedback && run.feedback.until > run.elapsed ? (
          <span className="bg-background px-2">{run.feedback.text}</span>
        ) : null}
        {run.checkpoint ? (
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
        <span className="bg-background px-2 text-ui-xs">
          {intl.formatMessage(
            { id: "saiasui.seed" },
            { mode: run.mode, seed: run.seed.slice(0, 8) },
          )}
        </span>
      </div>
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
            <button className="mt-4 border border-border px-3 py-1" type="button" onClick={onExit}>
              {intl.formatMessage({ id: "saiasui.return" })}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
