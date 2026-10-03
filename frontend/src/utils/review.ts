import type { MovementPart } from '../types/part';
import type { PartBaseline } from '../types/review';

/** 由零件列表生成复核基准（零件 id → 当前版本号） */
export function baselineOf(parts: MovementPart[]): PartBaseline {
  const baseline: PartBaseline = {};
  for (const p of parts) baseline[p.id] = p.revision;
  return baseline;
}

/** 只取指定零件 id 的复核基准（工序按关联零件建基准） */
export function baselineForIds(parts: MovementPart[], ids: string[]): PartBaseline {
  const byId = new Map(parts.map((p) => [p.id, p.revision]));
  const baseline: PartBaseline = {};
  for (const id of ids) {
    const rev = byId.get(id);
    if (rev !== undefined) baseline[id] = rev;
  }
  return baseline;
}

/** 两份基准是否一致（复核冲突检测：复核期间零件又变动则不一致） */
export function baselinesEqual(a: PartBaseline, b: PartBaseline): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  }
  return true;
}

/** 基准摘要文案，用于走时单等展示 */
export function baselineSummary(parts: MovementPart[]): string {
  if (parts.length === 0) return '无零件登记';
  const max = Math.max(...parts.map((p) => p.revision));
  return `共 ${parts.length} 项 · 最高版本 r${max}`;
}
