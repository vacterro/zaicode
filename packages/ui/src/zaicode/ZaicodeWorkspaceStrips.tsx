import type { ZaicodeAgentDefinition, ZaicodeJob, ZaicodeJobStatus } from "@zcode/shared";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { jobStatusGroup } from "@/zaicode/zaicodeStatus.js";
import { ZaicodeIcon } from "@/zaicode/zaicodeIconSlots.js";

/** The ZAICODE page's explanation strip and its one-line flow map. */

export const ZAICODE_WAITING_STATUSES: ReadonlySet<ZaicodeJobStatus> = new Set(["draft", "queued", "ready"]);

/** What ZAICODE is, in three steps; shown until the operator hides it. */
export function ZaicodeHelpStrip({ onHide, onTour }: { onHide: () => void; onTour: () => void }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex shrink-0 items-start gap-3 border-b border-border bg-card px-3 py-2">
      <ZaicodeIcon slot="workspace.help" className="mt-0.5 text-foreground-subtle" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-ui-xs text-foreground">
        <span className="font-medium">{intl.formatMessage({ id: "zaicode.help.what" })}</span>
        <span>{intl.formatMessage({ id: "zaicode.help.step1" })}</span>
        <span>{intl.formatMessage({ id: "zaicode.help.step2" })}</span>
        <span>{intl.formatMessage({ id: "zaicode.help.step3" })}</span>
        <span className="text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.help.pools" })}
        </span>
      </div>
      <Button size="sm" variant="outline" onClick={onTour} title="A short guided walk over the real screen">
        <Play className="size-3" />
        Show me how it works
      </Button>
      <Button size="sm" variant="ghost" onClick={onHide}>
        {intl.formatMessage({ id: "zaicode.help.hide" })}
      </Button>
    </div>
  );
}

/** One-line map of the whole system: who -> what -> result, with live counts. */
export function ZaicodeFlowBar({
  agents,
  jobs,
  autoRun,
}: {
  agents: readonly ZaicodeAgentDefinition[];
  jobs: readonly ZaicodeJob[];
  autoRun: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, number>) => intl.formatMessage({ id }, values);
  const enabled = agents.filter((agent) => agent.enabled).length;
  const waiting = jobs.filter((job) => ZAICODE_WAITING_STATUSES.has(job.status)).length;
  const running = jobs.filter((job) => job.status === "running" || job.status === "waiting").length;
  const done = jobs.filter((job) => job.status === "completed").length;
  const attention = jobs.filter((job) => jobStatusGroup(job.status) === "attention").length;
  const step = "flex min-w-0 items-center gap-1.5 truncate";
  const arrow = <span className="shrink-0 text-foreground-subtlest">{"->"}</span>;
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-ui-xs text-foreground-subtle">
      <span className={step} title={t("zaicode.flow.agentsHelp")}>
        <strong className="font-normal text-foreground">1 {t("zaicode.flow.agents")}</strong>
        {t("zaicode.flow.agentsCount", { total: agents.length, enabled })}
      </span>
      {arrow}
      <span className={step} title={t("zaicode.flow.queueHelp")}>
        <strong className="font-normal text-foreground">2 {t("zaicode.flow.queue")}</strong>
        {t("zaicode.flow.queueCount", { waiting, running })}
      </span>
      {arrow}
      <span className={step} title={t("zaicode.flow.resultsHelp")}>
        <strong className="font-normal text-foreground">3 {t("zaicode.flow.results")}</strong>
        {t("zaicode.flow.resultsCount", { done })}
        {attention > 0 ? (
          <span className="text-destructive">{t("zaicode.flow.attention", { attention })}</span>
        ) : null}
      </span>
      <span className="ml-auto shrink-0 text-foreground-subtlest">
        {t(
          autoRun
            ? "zaicode.flow.autoOn"
            : waiting > 0
              ? "zaicode.flow.autoOffWaiting"
              : "zaicode.flow.autoOff",
        )}
      </span>
    </div>
  );
}
