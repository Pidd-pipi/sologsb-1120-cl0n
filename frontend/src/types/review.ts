import type { MovementPart, PartDecision } from './part';

/**
 * 复核基准：零件在某次复核时的关键状态快照。
 * 工序与走时测试各自保存一份，用于判断是否失效（与当前零件状态不一致）。
 */
export interface PartBaselineEntry {
  decision: PartDecision;
  dimension: number;
  sourceLot: string;
  /** 复核时零件的版本号（乐观并发依据） */
  version: number;
  reviewedAt: number;
}

/** 零件 id → 基准快照 */
export type PartBaseline = Record<string, PartBaselineEntry>;

/** 复核状态：待复核 / 已复核 */
export type ReviewState = 'pending' | 'reviewed';

/** 零件保存版本冲突：其他标签页已先提交 */
export class VersionConflictError extends Error {
  constructor(public readonly current: MovementPart) {
    super('零件已被其他标签页修改，请重新载入后再保存');
    this.name = 'VersionConflictError';
  }
}

/** 复核冲突：复核期间零件再次变动 */
export class ReviewConflictError extends Error {
  constructor(public readonly changedPartIds: string[]) {
    super('复核期间零件又发生变动，请重新载入后再复核');
    this.name = 'ReviewConflictError';
  }
}

/**
 * 由零件列表构建复核基准快照。
 * 只收录存在的零件；已删除的零件不进基准（视为缺失）。
 */
export function buildBaseline(partIds: string[], parts: MovementPart[]): PartBaseline {
  const partMap = new Map(parts.map((p) => [p.id, p]));
  const baseline: PartBaseline = {};
  for (const pid of partIds) {
    const p = partMap.get(pid);
    if (p) {
      baseline[pid] = {
        decision: p.decision,
        dimension: p.dimension,
        sourceLot: p.sourceLot,
        version: p.version,
        reviewedAt: Date.now(),
      };
    }
  }
  return baseline;
}

/**
 * 判断基准是否失效：基准中任一零件的关键状态（处理决定/关键尺寸/来源批号）
 * 与当前零件不一致，或零件已被删除。
 */
export function isBaselineStale(baseline: PartBaseline | undefined, parts: MovementPart[]): boolean {
  if (!baseline || Object.keys(baseline).length === 0) return false;
  const partMap = new Map(parts.map((p) => [p.id, p]));
  for (const [pid, entry] of Object.entries(baseline)) {
    const current = partMap.get(pid);
    if (!current) return true;
    if (current.decision !== entry.decision) return true;
    if (current.dimension !== entry.dimension) return true;
    if (current.sourceLot !== entry.sourceLot) return true;
  }
  return false;
}

/** 从零件列表中提取 指定零件 id → 版本号 的映射（用于复核前的版本快照） */
export function snapshotVersions(parts: MovementPart[], partIds: string[]): Record<string, number> {
  const idSet = new Set(partIds);
  const versions: Record<string, number> = {};
  for (const p of parts) {
    if (idSet.has(p.id)) versions[p.id] = p.version;
  }
  return versions;
}
