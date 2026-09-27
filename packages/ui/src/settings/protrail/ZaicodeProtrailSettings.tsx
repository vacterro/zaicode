import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { PROTRAIL_COLOR_PRESETS, protrailRgbToHex } from "@/zaicode/protrail/protrailModel.js";
import { useZaicodeProtrail } from "@/zaicode/protrail/zaicodeProtrailStore.js";
import { useZaicodeProtrailGlobalStatus, zaicodeProtrailGlobalSupported } from "@/zaicode/protrail/zaicodeProtrailGlobal.js";
import type { ZaicodeProtrailGlobalStatus } from "@zcode/shared";
import { ZaicodeProtrailClickTab } from "./ZaicodeProtrailClickTab.js";
import { ProtrailCheck, ProtrailGrid, ProtrailGroup } from "./ZaicodeProtrailControls.js";
import { ZaicodeProtrailTrailTab } from "./ZaicodeProtrailTrailTab.js";

/**
 * Settings -> ProTrail (SRC-062): ProTrail (vacterro/protrail) inside
 * ZAICODE, with ProTrail's own three tabs. General holds the master switch,
 * where it draws (the whole desktop or only this window), the six colour
 * presets and the ZAICODE extras (pixel look, calm interface).
 */

type Tab = "general" | "trail" | "click";
const TABS: readonly { value: Tab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "trail", label: "Trail" },
  { value: "click", label: "Click" },
];

function statusLine(status: ZaicodeProtrailGlobalStatus): string {
  if (status.state === "off") return "Not drawing outside ZAICODE right now.";
  if (status.state === "unavailable") return status.note ?? "Not available in this build.";
  const monitors = `${status.displays} monitor${status.displays === 1 ? "" : "s"}`;
  if (status.state === "starting") return `Starting over ${monitors}…${status.note ? ` ${status.note}` : ""}`;
  const source = status.input === "raw-input" ? "moves and clicks (Raw Input)" : "the cursor only (no clicks)";
  return `Drawing over ${monitors}, reading ${source}.${status.note ? ` ${status.note}` : ""}`;
}

function GeneralTab() {
  const { config, set, setTrail, setClick, resetAll } = useZaicodeProtrail();
  const status = useZaicodeProtrailGlobalStatus();
  const desktop = zaicodeProtrailGlobalSupported();
  const off = !config.enabled;
  return (
    <div className="flex flex-col gap-2">
      <ProtrailGroup
        title="ProTrail"
        right={
          <button type="button" className="flex items-center gap-1 border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover" onClick={resetAll}>
            <RotateCcw className="size-3" /> Restore all defaults
          </button>
        }
      >
        <ProtrailCheck label="ProTrail is on (the trail behind the cursor and the click effects)" checked={config.enabled} onChange={(enabled) => set({ enabled })} />
        <div className="flex flex-wrap gap-3">
          <ProtrailCheck label="Trail" checked={config.trail.enabled} disabled={off} onChange={(enabled) => setTrail({ enabled })} />
          <ProtrailCheck label="Click effects" checked={config.click.enabled} disabled={off} onChange={(enabled) => setClick({ enabled })} />
        </div>
      </ProtrailGroup>
      <ProtrailGroup title="Where it draws">
        <ProtrailGrid
          value={config.everywhere ? "everywhere" : "window"}
          columns={2}
          disabled={off}
          options={[
            { value: "everywhere", label: "Everywhere in Windows", hint: "Over every monitor and every app, like ProTrail itself" },
            { value: "window", label: "Only inside ZAICODE", hint: "Only over the ZAICODE window" },
          ]}
          onChange={(value) => set({ everywhere: value === "everywhere" })}
        />
        {config.everywhere ? (
          <span className="text-foreground-subtle" data-zaicode-protrail-status={status.state}>
            {desktop ? statusLine(status) : "This build has no desktop app, so ProTrail draws only inside ZAICODE."}
          </span>
        ) : null}
        <span className="text-foreground-subtle">
          Clicks always reach the app under the cursor: every ProTrail layer is click-through and never takes focus.
        </span>
      </ProtrailGroup>
      <ProtrailGroup title="Colour presets">
        <div className="grid grid-cols-3 gap-px md:grid-cols-6">
          {PROTRAIL_COLOR_PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              disabled={off}
              title={`Trail ${preset.mode === "full" ? "solid" : "gradient"}, click colour included`}
              className="flex items-center gap-1.5 border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground disabled:opacity-50"
              onClick={() => {
                setTrail({ colorMode: preset.mode, start: preset.start, fade: preset.fade });
                setClick({ color: preset.click });
              }}
            >
              <span
                className="size-3 shrink-0 border border-border"
                style={{ background: `linear-gradient(90deg, ${protrailRgbToHex(preset.start)}, ${protrailRgbToHex(preset.fade)})` }}
              />
              {preset.name}
            </button>
          ))}
        </div>
      </ProtrailGroup>
      <ProtrailGroup title="ZAICODE look">
        <ProtrailGrid
          label="Pixel size (1 = ProTrail's smooth look; 2-4 = hard pixel edges)"
          value={String(config.pixelSize)}
          columns={4}
          disabled={off}
          options={["1", "2", "3", "4"].map((value) => ({ value, label: value === "1" ? "Smooth" : `${value} px` }))}
          onChange={(value) => set({ pixelSize: Number(value) })}
        />
        <ProtrailCheck
          label="Pause while the calm interface (no animations) is on"
          checked={config.followCalm}
          disabled={off}
          onChange={(followCalm) => set({ followCalm })}
        />
      </ProtrailGroup>
    </div>
  );
}

export function ZaicodeProtrailSettings() {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4 text-ui-xs" data-zaicode-protrail-settings data-zaicode-help="protrail">
      <div>
        <h2 className="text-ui-lg text-foreground">ProTrail</h2>
        <p className="mt-1 max-w-[620px] text-foreground-subtle">
          ProTrail's cursor trail and click effects, built into ZAICODE with every one of its settings: eight trail
          styles, sparkles, eleven click styles, press-and-hold with a charged release and the motion wake. Move the
          mouse or click anywhere to see a change right away.
        </p>
      </div>
      <ProtrailGrid value={tab} columns={3} options={TABS} onChange={setTab} />
      {tab === "general" ? <GeneralTab /> : tab === "trail" ? <ZaicodeProtrailTrailTab /> : <ZaicodeProtrailClickTab />}
    </section>
  );
}
