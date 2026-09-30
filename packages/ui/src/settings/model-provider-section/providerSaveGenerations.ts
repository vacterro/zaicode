/** 保存通知按目标分代；另一模型的保存不能让已完成的通知永远停在 pending。 */
export function beginProviderSave(generations: Map<string, number>, key: string): number {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

export function isCurrentProviderSave(generations: ReadonlyMap<string, number>, key: string, generation: number): boolean {
  return generations.get(key) === generation;
}
