import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../../zcode");
function update(path, replacements) {
  let source = execFileSync("git", ["show", `HEAD:${path}`], { cwd: root, encoding: "utf8" });
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error(`Expected one match: ${before}`);
    source = source.replace(before, after);
  }
  writeFileSync(resolve(root, path), source, "utf8");
}
update("packages/ui/src/zaicode/home/ZaicodeHomePage.tsx", [
  ["  zaicodeHomeQueueCounts,\n", ""],
  ["  const queue = zaicodeHomeQueueCounts(feed.jobs.value, zaicodeStartOfToday(now));",
    "  const dayStart = zaicodeStartOfToday(now);\n  const overview = feed.jobs.value;\n  const queue = overview?.dayStart === dayStart ? overview.counts : null;\n  // T-254 — 跨过本地午夜后旧日计数不可继续显示；复用当前刷新，不增加定时器。\n  useEffect(() => {\n    if (overview && overview.dayStart !== dayStart) void refreshZaicodeHome();\n  }, [dayStart, overview?.dayStart, feed.lastRefreshAt]);"],
  ["jobs={feed.jobs.value}", "overview={overview}"],
]);
update("packages/ui/src/zaicode/home/ZaicodeHomeFleet.tsx", [
  ["type ZaicodeJob,", "type ZaicodeHomeQueueOverview,"],
  ["  jobs,\n", "  overview,\n"],
  ["  jobs: readonly ZaicodeJob[] | null;", "  overview: ZaicodeHomeQueueOverview | null;"],
  ["const runningJobs = (jobs ?? []).filter", "const runningJobs = (overview?.jobs ?? []).filter"],
  ["const blockedJobs = (jobs ?? []).filter((job) => job.status === \"blocked\").length;", "const blockedJobs = overview?.counts.blocked ?? 0;"],
  ["const readyJobs = (jobs ?? []).filter((job) => job.status === \"queued\" || job.status === \"ready\").length;", "const readyJobs = overview?.counts.ready ?? 0;"],
  ["const recent = (jobs ?? []).filter((job) => job.status === \"completed\" && job.finishedAt !== undefined && now - job.finishedAt < 86_400_000).length;", "const recent = overview?.doneLast24h ?? 0;"],
  ["`${sessions.length + runningWorkers.length + runningJobs.length} running`", "`${sessions.length + runningWorkers.length + (overview?.counts.running ?? 0)} running`"],
  [">Nothing runs right now.</span>", ">{overview?.diagnostics.length ? \"Queue data needs attention.\" : \"Nothing runs right now.\"}</span>"],
]);
