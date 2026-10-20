// 每个 RPC service proxy 对应一个 attachment；hello/clientHello 只做一次，所有
// conversation/sessions-index transport 共享该 Promise，避免并发首订阅重复握手。
import type { IZCodeAgentService } from "@zcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  type HelloMessage,
} from "@zcode/shared/zcode-protocol-v4";
import { getV4ClientId } from "@/v4/commandFactory.js";

type AgentV4HandshakeService = Pick<
  IZCodeAgentService,
  "helloConversationV4" | "initializeConversationV4"
>;

export interface V4HostClockSample {
  readonly serverTime: number;
  readonly receivedAt: number;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : NaN;
}

function captureHostClock(serverTime: number): V4HostClockSample | null {
  const receivedAt = monotonicNow();
  return Number.isFinite(serverTime) && Number.isFinite(receivedAt)
    ? { serverTime, receivedAt } : null;
}

export function readV4HostClock(sample: V4HostClockSample | null, now = monotonicNow()): number | null {
  if (!sample || !Number.isFinite(now) || now < sample.receivedAt) return null;
  const epoch = sample.serverTime + now - sample.receivedAt;
  return Number.isFinite(epoch) && !Number.isNaN(new Date(epoch).getTime()) ? epoch : null;
}

interface AgentV4HandshakeRecord {
  promise?: Promise<HelloMessage>;
  sample: V4HostClockSample | null;
}
const handshakes = new WeakMap<object, AgentV4HandshakeRecord>();

export function getAgentV4HostClockSample(service: AgentV4HandshakeService): V4HostClockSample | null {
  return handshakes.get(service as object)?.sample ?? null;
}

export function readAgentV4HostNow(service: AgentV4HandshakeService): number | null {
  return readV4HostClock(getAgentV4HostClockSample(service));
}

/** 时钟只读续采样；同一 attachment 不再 initialize，旧握手的收到时间也不被重置。 */
export async function refreshAgentV4HostClock(service: AgentV4HandshakeService): Promise<V4HostClockSample> {
  const admitted = await ensureAgentV4ConnectionHandshake(service);
  const hello = helloMessageSchema.parse(await service.helloConversationV4());
  const sample = captureHostClock(hello.serverTime);
  if (hello.connectionId !== admitted.connectionId || !sample)
    throw new Error("Host clock attachment or monotonic reading is unavailable.");
  return sample;
}

export function ensureAgentV4ConnectionHandshake(
  service: AgentV4HandshakeService,
): Promise<HelloMessage> {
  const key = service as object;
  const existing = handshakes.get(key)?.promise;
  if (existing) return existing;

  const record: AgentV4HandshakeRecord = { sample: null };
  const handshake = (async () => {
    const hello = helloMessageSchema.parse(await service.helloConversationV4());
    const sample = captureHostClock(hello.serverTime);
    await service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      // handshake 与 commandFactory 曾各生成一套页面 clientId，facade
      // 无法验证 command envelope 是否属于已绑定客户端。统一复用持久化 V4 clientId。
      clientId: getV4ClientId(),
      clientKind: hello.clientMode === "desktop-continuous" ? "desktop" : "web",
      appVersion: "unknown",
      capabilities: { workspaceHookReviewUi: true },
    });
    if (handshakes.get(key) === record) record.sample = sample;
    return hello;
  })();
  record.promise = handshake;
  handshakes.set(key, record);
  void handshake.catch(() => {
    if (handshakes.get(key)?.promise === handshake) handshakes.delete(key);
  });
  return handshake;
}
