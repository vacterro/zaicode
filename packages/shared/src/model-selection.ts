import { z } from "zod";
import { isZaicodeProductMode } from "./zaicode.js";

/** 用户对后续模型执行的完整选择；不表达已经创建的 Active Model。 */
export const modelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** 公共解析结果。页面可以展示不完整选择，执行入口必须同时检查 selectionIssue。 */
export interface EffectiveModelSelectionResult {
  readonly effectiveSelection: ModelSelection | null;
  readonly selectionIssue?:
    | "selection-missing"
    | "account-connection-unavailable"
    | "provider-not-found"
    | "model-not-found"
    | "reasoning-level-missing"
    | "reasoning-level-not-supported";
}

export const ZCODE_MODEL_REASONING_SEPARATOR = "$";

const BINARY_REASONING_OFF = new Set([
  "disable",
  "disabled",
  "false",
  "no",
  "none",
  "nothink",
  "no-think",
  "no_think",
  "off",
]);
const BINARY_REASONING_ON = new Set(["enable", "enabled", "on", "true"]);

export function isThoughtLevelOff(value: string): boolean {
  return BINARY_REASONING_OFF.has(value.trim().toLowerCase());
}

export function isThoughtLevelOn(value: string): boolean {
  return BINARY_REASONING_ON.has(value.trim().toLowerCase());
}

/**
 * T-143: a list of nothing but on/off markers is a switch, not an effort scale. The only
 * question it can ask is "dumb model or smart model", and ZAICODE never takes "dumb", so
 * such a model gets no thought control at all. Real effort scales keep theirs.
 */
export function isThoughtLevelSwitch(values: readonly string[]): boolean {
  if (!isZaicodeProductMode() || values.length === 0 || values.length > 2) return false;
  return values.every((value) => isThoughtLevelOn(value) || isThoughtLevelOff(value));
}

/** A binary switch is a fixed enabled choice in ZAICODE; graded efforts keep their controls. */
export function fixedEnabledReasoningLevel(values: readonly string[]): string | null {
  if (!isZaicodeProductMode()) return null;
  if (values.length === 1) {
    return isThoughtLevelOn(values[0]!) ? values[0]! : null;
  }
  if (values.length !== 2) return null;
  const enabled = values.find(isThoughtLevelOn);
  const disabled = values.find(isThoughtLevelOff);
  return enabled && disabled && enabled !== disabled ? enabled : null;
}

/**
 * T-143: the levels a ZAICODE user may still pick. An off marker is never one of them --
 * a model that can think is never parked in "does not think", not even by a stale session.
 */
export function selectableThoughtLevels(values: readonly string[]): readonly string[] {
  if (!isZaicodeProductMode()) return values;
  return values.filter((value) => !isThoughtLevelOff(value));
}

/** The strongest level that still means "think"; null when the model never thinks. */
export function strongestThinkingLevel(values: readonly string[]): string | null {
  return selectableThoughtLevels(values).at(-1) ?? null;
}

/** UI Picker/legacy CLI 的展示值；不是可逆的 ModelSelection 序列化格式。 */
export function formatModelPickerValue(selection: ModelSelection | undefined): string {
  // 只在显示边界把未绑定表示为空；实际执行仍校验完整 ModelSelection。
  if (!selection) return "";
  const base = `${selection.providerId}/${selection.modelId}`;
  const reasoningLevel = selection.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

/** 只解析 Picker/legacy 字符串边界；领域状态与协议必须直接保存 ModelSelection。 */
export function parseModelPickerValue(value: string): ModelSelection {
  const normalized = value.trim();
  const providerSeparatorIndex = normalized.indexOf("/");
  if (providerSeparatorIndex <= 0) {
    throw new Error(`模型选择缺少 Provider: ${normalized}`);
  }
  const providerId = normalized.slice(0, providerSeparatorIndex);
  const rawModelId = normalized.slice(providerSeparatorIndex + 1);
  const reasoningSeparatorIndex = rawModelId.indexOf(ZCODE_MODEL_REASONING_SEPARATOR);
  if (reasoningSeparatorIndex <= 0 || reasoningSeparatorIndex >= rawModelId.length - 1) {
    return modelSelectionSchema.parse({ providerId, modelId: rawModelId });
  }
  return modelSelectionSchema.parse({
    providerId,
    modelId: rawModelId.slice(0, reasoningSeparatorIndex),
    options: { reasoningLevel: rawModelId.slice(reasoningSeparatorIndex + 1) },
  });
}
