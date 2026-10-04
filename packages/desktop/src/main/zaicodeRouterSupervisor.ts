/** Router host's single recovery owner. Ports keep process/HTTP/persistence out of the state machine. */
export type RouterHealth = "healthy" | "process-unavailable" | "api-unhealthy" | "connection-failure";
export interface RouterSupervisorState {
  version: 1;
  route: "preferred" | "fallback";
  status: "preferred" | "preferred-unavailable" | "recovering" | "fallback-active" | "restored" | "unavailable";
  failure: Exclude<RouterHealth, "healthy"> | null;
  attempts: number;
  nextAttemptAt: number;
  lastProbeAt: number;
  healthyProbes: number;
  cooldownUntil: number;
  healthySince: number | null;
  pendingRecovery: boolean;
}
interface Ports {
  probe(): Promise<RouterHealth>;
  recover(): Promise<void>;
  fallback(): Promise<boolean>;
  persist(state: RouterSupervisorState): Promise<void>;
  now(): number;
  wait(ms: number): Promise<void>;
}
const PROBE_MS = 30_000;
const COOLDOWN_MS = 60_000;
const RESET_BUDGET_MS = 10 * 60_000;
const initial = (): RouterSupervisorState => ({ version: 1, route: "preferred", status: "preferred", failure: null, attempts: 0, nextAttemptAt: 0, lastProbeAt: 0, healthyProbes: 0, cooldownUntil: 0, healthySince: null, pendingRecovery: false });

export class ZaicodeRouterSupervisor {
  #state: RouterSupervisorState;
  #inflight: Promise<void> | null = null;
  #tail: Promise<void> = Promise.resolve();
  #fallbackReady = false;
  #fallbackLastAttempt = -Infinity;
  constructor(private readonly ports: Ports, saved?: RouterSupervisorState) {
    this.#state = saved?.version === 1 ? { ...initial(), ...saved, attempts: Math.min(10, Math.max(0, Math.floor(saved.attempts || 0))) } : initial();
    // 进程重启后不能把旧健康观测当作现在仍健康；预算和回退驻留时间保留。
    this.#state.lastProbeAt = 0;
    this.#state.healthyProbes = 0;
    this.#state.healthySince = null;
    if (this.#state.route === "fallback") this.#state.status = "unavailable";
  }
  get state(): Readonly<RouterSupervisorState> { return { ...this.#state }; }

  async #save(patch: Partial<RouterSupervisorState>): Promise<void> {
    this.#state = { ...this.#state, ...patch };
    await this.ports.persist({ ...this.#state });
  }
  async tick(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#exclusive(() => this.#tick()).finally(() => { this.#inflight = null; });
    return this.#inflight;
  }
  #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(action);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
  async #ensureFallback(): Promise<boolean> {
    const now = this.ports.now();
    if (!this.#fallbackReady && now - this.#fallbackLastAttempt < PROBE_MS) return false;
    this.#fallbackLastAttempt = now;
    this.#fallbackReady = await this.ports.fallback().catch(() => false);
    await this.#save({ status: this.#fallbackReady ? "fallback-active" : "unavailable" });
    return this.#fallbackReady;
  }
  async #tick(): Promise<void> {
    let now = this.ports.now();
    if (this.#state.route === "fallback" && now - this.#state.lastProbeAt < PROBE_MS) return;
    if (this.#state.pendingRecovery && now < this.#state.nextAttemptAt) return;
    let health = await this.ports.probe();
    if (health === "connection-failure" && this.#state.route === "preferred") {
      await this.#save({ status: "preferred-unavailable", failure: health });
      await this.ports.wait(500);
      health = await this.ports.probe();
    }
    now = this.ports.now();
    if (health === "healthy") {
      const healthySince = this.#state.healthySince ?? now;
      await this.#save({ lastProbeAt: now, healthyProbes: this.#state.healthyProbes + 1, healthySince, pendingRecovery: false, failure: null,
        ...(this.#state.route === "preferred" ? { status: this.#state.attempts ? "restored" : "preferred" } : {}),
        ...(this.#state.route === "preferred" && now - healthySince >= RESET_BUDGET_MS ? { attempts: 0 } : {}),
      });
      return;
    }
    await this.#save({ failure: health, lastProbeAt: now, healthyProbes: 0, healthySince: null, pendingRecovery: true, status: this.#state.route === "fallback" ? this.#state.status : "preferred-unavailable" });
    if (this.#state.route === "fallback") {
      await this.#ensureFallback();
      return;
    }
    if (this.#state.attempts < 10) {
      // 先持久化已消耗的预算；重启不能把刚发出的恢复动作忘掉再无限重放。
      await this.#save({ attempts: this.#state.attempts + 1, status: "recovering" });
      await this.ports.recover().catch(() => undefined);
      const after = await this.ports.probe();
      if (after === "healthy") {
        await this.#save({ status: "restored", failure: null, pendingRecovery: false, healthySince: this.ports.now(), healthyProbes: 1, lastProbeAt: this.ports.now() });
        return;
      }
      await this.#save({ failure: after, nextAttemptAt: this.ports.now() + Math.min(5000, 500 * 2 ** (this.#state.attempts - 1)) });
    }
    if (this.#state.attempts >= 10) {
      await this.#save({ route: "fallback", cooldownUntil: this.ports.now() + COOLDOWN_MS, status: "unavailable", lastProbeAt: this.ports.now() });
      await this.#ensureFallback();
    }
  }
  /** A probe records recovery; only new inference admission may change the selected route. */
  async boundary(): Promise<"preferred" | "fallback" | null> {
    await this.tick();
    while (this.#state.route === "preferred" && this.#state.pendingRecovery && this.#state.attempts < 10) {
      await this.ports.wait(Math.max(0, this.#state.nextAttemptAt - this.ports.now()));
      await this.tick();
    }
    // tick 和续跑边界共享同一串行 owner；并发推理不能竞争同一个持久化临时文件。
    return this.#exclusive(async () => {
    if (this.#state.route === "fallback") {
      if (this.#state.healthyProbes >= 2 && this.ports.now() >= this.#state.cooldownUntil) {
        await this.#save({ route: "preferred", status: "restored", pendingRecovery: false });
        return "preferred";
      }
      return await this.#ensureFallback() ? "fallback" : null;
    }
    return this.#state.failure ? null : "preferred";
    });
  }
  inferenceFailure(kind: "quota" | "provider-model"): void {
    // 健康路由器后面的厂商限额/模型失败不触发进程恢复，更不重放已派发的推理。
    void kind;
  }
}
