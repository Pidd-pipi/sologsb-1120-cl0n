import { db, toPlain } from './db';
import { newId } from './id';
import { baselineForIds, baselineOf, baselinesEqual } from './review';
import { avgAmplitude, avgBeatError, avgRate } from './timeCalc';
import { judgeTest } from '../types/test';
import type { MovementPart, MovementPartDraft } from '../types/part';
import type { RepairStep } from '../types/step';
import type { TimekeepingTest } from '../types/test';
import type { PartBaseline } from '../types/review';

/** 零件保存结果 */
export type SavePartResult =
  | { ok: true; part: MovementPart; invalidatedSteps: number; invalidatedTests: number }
  | { ok: false; reason: 'conflict'; current: MovementPart }
  | { ok: false; reason: 'not-found' };

/** 零件删除结果 */
export type RemovePartResult =
  | { ok: true; invalidatedSteps: number; invalidatedTests: number }
  | { ok: false; reason: 'not-found' };

/** 复核结果：conflict=复核期间零件又变动，记录保持待复核 */
export type ReviewResult = { ok: true } | { ok: false; reason: 'conflict' | 'not-found' };

/** 失效/复核流程涉及的原记录快照，用于失败时恢复 */
interface Snapshot {
  parts: MovementPart[];
  steps: RepairStep[];
  tests: TimekeepingTest[];
}

const EMPTY_SNAPSHOT: Snapshot = { parts: [], steps: [], tests: [] };

/**
 * 流程失败时恢复原记录。
 * Dexie 事务本身会回滚，这里再做一次补偿式恢复作为兜底，
 * 保证「失效流程失败后原记录仍在」，调用方随后可提示重试。
 */
async function restoreSnapshot(snapshot: Snapshot): Promise<void> {
  if (!snapshot.parts.length && !snapshot.steps.length && !snapshot.tests.length) return;
  await db.transaction('rw', db.parts, db.steps, db.tests, async () => {
    if (snapshot.parts.length) await db.parts.bulkPut(toPlain(snapshot.parts));
    if (snapshot.steps.length) await db.steps.bulkPut(toPlain(snapshot.steps));
    if (snapshot.tests.length) await db.tests.bulkPut(toPlain(snapshot.tests));
  });
}

/** 从补丁中剔除不允许覆盖的字段 */
function sanitizePatch(patch: Partial<MovementPart>): Partial<MovementPart> {
  const clean = toPlain(patch) as Record<string, unknown>;
  delete clean.id;
  delete clean.clockId;
  delete clean.revision;
  delete clean.updatedAt;
  return clean as Partial<MovementPart>;
}

/**
 * 登记零件：新零件进入零件基准，本钟表未失效的走时测试一并置为待复核。
 */
export async function applyPartAdd(draft: MovementPartDraft): Promise<SavePartResult> {
  const record: MovementPart = {
    ...toPlain(draft),
    id: newId('prt'),
    revision: 1,
    updatedAt: Date.now(),
  };
  let result: SavePartResult | null = null;
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  try {
    await db.transaction('rw', db.parts, db.steps, db.tests, async () => {
      const tests = await db.tests.where('clockId').equals(record.clockId).toArray();
      const hitTests = tests.filter((t) => t.reviewState !== 'stale');
      snapshot = { parts: [], steps: [], tests: toPlain(hitTests) };
      await db.parts.put(toPlain(record));
      for (const t of hitTests) await db.tests.update(t.id, { reviewState: 'stale' });
      result = { ok: true, part: record, invalidatedSteps: 0, invalidatedTests: hitTests.length };
    });
  } catch (err) {
    await db.parts.delete(record.id).catch(() => undefined);
    await restoreSnapshot(snapshot);
    throw err;
  }
  if (!result) throw new Error('零件登记未完成');
  return result;
}

/**
 * 修改零件：版本号 +1，并让引用该零件的工序与本钟表走时测试失效待复核。
 * baseRevision 为编辑时读到的版本（多标签乐观锁）：与库中不一致则拒绝保存，
 * 后保存页面不得覆盖先提交的零件版本。
 */
export async function applyPartUpdate(
  id: string,
  patch: Partial<MovementPart>,
  baseRevision?: number,
): Promise<SavePartResult> {
  let result: SavePartResult | null = null;
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  try {
    await db.transaction('rw', db.parts, db.steps, db.tests, async () => {
      const current = await db.parts.get(id);
      if (!current) {
        result = { ok: false, reason: 'not-found' };
        return;
      }
      if (baseRevision !== undefined && current.revision !== baseRevision) {
        result = { ok: false, reason: 'conflict', current: toPlain(current) };
        return;
      }
      const steps = await db.steps.where('clockId').equals(current.clockId).toArray();
      const tests = await db.tests.where('clockId').equals(current.clockId).toArray();
      const hitSteps = steps.filter((s) => s.partIds.includes(id) && s.reviewState !== 'stale');
      const hitTests = tests.filter((t) => t.reviewState !== 'stale');
      snapshot = { parts: [toPlain(current)], steps: toPlain(hitSteps), tests: toPlain(hitTests) };

      const next: MovementPart = {
        ...current,
        ...sanitizePatch(patch),
        id: current.id,
        clockId: current.clockId,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      };
      await db.parts.put(toPlain(next));
      for (const s of hitSteps) await db.steps.update(s.id, { reviewState: 'stale' });
      for (const t of hitTests) await db.tests.update(t.id, { reviewState: 'stale' });
      result = { ok: true, part: next, invalidatedSteps: hitSteps.length, invalidatedTests: hitTests.length };
    });
  } catch (err) {
    await restoreSnapshot(snapshot);
    throw err;
  }
  if (!result) throw new Error('零件保存未完成');
  return result;
}

/**
 * 删除零件：引用该零件的工序与本钟表走时测试失效待复核（工序上的引用在复核时剔除）。
 */
export async function applyPartRemove(id: string): Promise<RemovePartResult> {
  let result: RemovePartResult | null = null;
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  try {
    await db.transaction('rw', db.parts, db.steps, db.tests, async () => {
      const current = await db.parts.get(id);
      if (!current) {
        result = { ok: false, reason: 'not-found' };
        return;
      }
      const steps = await db.steps.where('clockId').equals(current.clockId).toArray();
      const tests = await db.tests.where('clockId').equals(current.clockId).toArray();
      const hitSteps = steps.filter((s) => s.partIds.includes(id) && s.reviewState !== 'stale');
      const hitTests = tests.filter((t) => t.reviewState !== 'stale');
      snapshot = { parts: [toPlain(current)], steps: toPlain(hitSteps), tests: toPlain(hitTests) };
      await db.parts.delete(id);
      for (const s of hitSteps) await db.steps.update(s.id, { reviewState: 'stale' });
      for (const t of hitTests) await db.tests.update(t.id, { reviewState: 'stale' });
      result = { ok: true, invalidatedSteps: hitSteps.length, invalidatedTests: hitTests.length };
    });
  } catch (err) {
    await restoreSnapshot(snapshot);
    throw err;
  }
  if (!result) throw new Error('零件删除未完成');
  return result;
}

/**
 * 复核工序：seenBaseline 为复核界面打开时看到的零件版本。
 * 若确认时零件又变过（与库中当前基准不一致），提示冲突并保持待复核；
 * 否则剔除已删除的关联零件、按当前版本重立基准，记录恢复有效。
 */
export async function reviewStep(id: string, seenBaseline: PartBaseline): Promise<ReviewResult> {
  let result: ReviewResult | null = null;
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  try {
    await db.transaction('rw', db.parts, db.steps, async () => {
      const step = await db.steps.get(id);
      if (!step) {
        result = { ok: false, reason: 'not-found' };
        return;
      }
      const clockParts = await db.parts.where('clockId').equals(step.clockId).toArray();
      const currentBaseline = baselineForIds(clockParts, step.partIds);
      if (!baselinesEqual(currentBaseline, seenBaseline)) {
        result = { ok: false, reason: 'conflict' };
        return;
      }
      snapshot = { parts: [], steps: [toPlain(step)], tests: [] };
      const alive = new Set(clockParts.map((p) => p.id));
      const partIds = step.partIds.filter((pid) => alive.has(pid));
      await db.steps.update(id, {
        partIds,
        partBaseline: baselineForIds(clockParts, partIds),
        reviewState: 'valid',
      });
      result = { ok: true };
    });
  } catch (err) {
    await restoreSnapshot(snapshot);
    throw err;
  }
  if (!result) throw new Error('复核未完成');
  return result;
}

/**
 * 复核走时测试：冲突检测同工序；
 * 通过则按方位读数重算均值与结论（失效重算），按当前零件版本重立基准。
 */
export async function reviewTest(id: string, seenBaseline: PartBaseline): Promise<ReviewResult> {
  let result: ReviewResult | null = null;
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  try {
    await db.transaction('rw', db.parts, db.tests, async () => {
      const test = await db.tests.get(id);
      if (!test) {
        result = { ok: false, reason: 'not-found' };
        return;
      }
      const clockParts = await db.parts.where('clockId').equals(test.clockId).toArray();
      const currentBaseline = baselineOf(clockParts);
      if (!baselinesEqual(currentBaseline, seenBaseline)) {
        result = { ok: false, reason: 'conflict' };
        return;
      }
      snapshot = { parts: [], steps: [], tests: [toPlain(test)] };
      const rate = test.positions.length ? avgRate(test.positions) : test.rate;
      const amplitude = test.positions.length ? avgAmplitude(test.positions) : test.amplitude;
      const beatError = test.positions.length ? avgBeatError(test.positions) : test.beatError;
      await db.tests.update(id, {
        rate,
        amplitude,
        beatError,
        conclusion: judgeTest(rate, beatError, amplitude),
        partBaseline: currentBaseline,
        reviewState: 'valid',
      });
      result = { ok: true };
    });
  } catch (err) {
    await restoreSnapshot(snapshot);
    throw err;
  }
  if (!result) throw new Error('复核未完成');
  return result;
}
