import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import {
  buildBaseline,
  isBaselineStale,
  ReviewConflictError,
  type PartBaseline,
} from '../types/review';
import type { MovementPart } from '../types/part';
import type { RepairStep, RepairStepDraft } from '../types/step';
import type { TimekeepingTest, TimekeepingTestDraft } from '../types/test';

interface StepState {
  items: RepairStep[];
  tests: TimekeepingTest[];
  loaded: boolean;
}

export const useStepStore = defineStore('step', {
  state: (): StepState => ({ items: [], tests: [], loaded: false }),
  getters: {
    byClock: (state) => (clockId: string) =>
      state.items.filter((it) => it.clockId === clockId).sort((a, b) => a.seq - b.seq),
    testsByClock: (state) => (clockId: string) =>
      state.tests.filter((it) => it.clockId === clockId).sort((a, b) => b.testedAt - a.testedAt),
    /** 某钟下已失效（待复核）的工序 */
    staleSteps: (state) => (clockId: string, parts: MovementPart[]) =>
      state.items.filter((s) => s.clockId === clockId && isBaselineStale(s.partBaseline, parts)),
    /** 某钟下已失效（待复核）的走时测试 */
    staleTests: (state) => (clockId: string, parts: MovementPart[]) =>
      state.tests.filter((t) => t.clockId === clockId && isBaselineStale(t.partBaseline, parts)),
  },
  actions: {
    async load() {
      const steps = await db.steps.toArray();
      steps.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
      this.items = steps;
      const tests = await db.tests.toArray();
      this.tests = tests.sort((a, b) => b.testedAt - a.testedAt);
      this.loaded = true;
    },
    async add(draft: RepairStepDraft) {
      const parts = await db.parts.where('clockId').equals(draft.clockId).toArray();
      const partBaseline = buildBaseline(draft.partIds, parts);
      const record: RepairStep = {
        ...toPlain(draft),
        id: newId('stp'),
        reviewState: 'reviewed',
        partBaseline,
        reviewedAt: Date.now(),
      };
      await db.steps.put(toPlain(record));
      this.items = [...this.items, record];
      return record;
    },
    async finish(id: string) {
      const patch: Partial<RepairStep> = { state: 'done', finishedAt: Date.now() };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    },
    async rollback(id: string) {
      const patch: Partial<RepairStep> = { state: 'rolledback', finishedAt: undefined };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    },
    /** 上下移动排序：交换两个相邻步骤的 seq */
    async swapSeq(aId: string, bId: string) {
      const a = this.items.find((it) => it.id === aId);
      const b = this.items.find((it) => it.id === bId);
      if (!a || !b) return;
      const aSeq = a.seq;
      await db.steps.update(a.id, { seq: b.seq });
      await db.steps.update(b.id, { seq: aSeq });
      this.items = this.items.map((it) => {
        if (it.id === a.id) return { ...it, seq: b.seq };
        if (it.id === b.id) return { ...it, seq: aSeq };
        return it;
      });
    },
    async addTest(draft: TimekeepingTestDraft) {
      const parts = await db.parts.where('clockId').equals(draft.clockId).toArray();
      const partBaseline = buildBaseline(
        parts.map((p) => p.id),
        parts,
      );
      const record: TimekeepingTest = {
        ...toPlain(draft),
        id: newId('tst'),
        reviewState: 'reviewed',
        partBaseline,
        reviewedAt: Date.now(),
      };
      await db.tests.put(toPlain(record));
      this.tests = [record, ...this.tests];
      return record;
    },
    async removeTest(id: string) {
      await db.tests.delete(id);
      this.tests = this.tests.filter((it) => it.id !== id);
    },
    /**
     * 工序复核：按当前零件状态重新基准化。
     * 复核前由 UI 传入各关联零件的版本快照；若任一零件版本已变动（复核期间又变过），
     * 抛 ReviewConflictError，保留待复核状态。
     */
    async reviewStep(stepId: string, expectedVersions: Record<string, number>) {
      const step = this.items.find((s) => s.id === stepId);
      if (!step) throw new Error('工序不存在');
      const parts = await db.parts.where('clockId').equals(step.clockId).toArray();
      const partMap = new Map(parts.map((p) => [p.id, p]));
      const changed: string[] = [];
      for (const pid of step.partIds) {
        const expected = expectedVersions[pid];
        if (expected === undefined) continue; // 复核前已删除的零件不视为冲突
        const current = partMap.get(pid);
        if (!current || current.version !== expected) changed.push(pid);
      }
      if (changed.length) throw new ReviewConflictError(changed);

      const partBaseline: PartBaseline = buildBaseline(step.partIds, parts);
      const now = Date.now();
      await db.steps.update(stepId, { reviewState: 'reviewed', partBaseline, reviewedAt: now });
      this.items = this.items.map((s) =>
        s.id === stepId ? { ...s, reviewState: 'reviewed', partBaseline, reviewedAt: now } : s,
      );
    },
    /**
     * 走时测试复核：按该钟当前全部零件状态重新基准化。
     * 复核前由 UI 传入各零件版本快照；若任一零件版本已变动，抛 ReviewConflictError。
     */
    async reviewTest(testId: string, expectedVersions: Record<string, number>) {
      const test = this.tests.find((t) => t.id === testId);
      if (!test) throw new Error('走时测试不存在');
      const parts = await db.parts.where('clockId').equals(test.clockId).toArray();
      const partMap = new Map(parts.map((p) => [p.id, p]));
      const changed: string[] = [];
      for (const pid of Object.keys(expectedVersions)) {
        const expected = expectedVersions[pid];
        if (expected === undefined) continue; // 复核前已删除的零件不视为冲突
        const current = partMap.get(pid);
        if (!current || current.version !== expected) changed.push(pid);
      }
      if (changed.length) throw new ReviewConflictError(changed);

      const partBaseline: PartBaseline = buildBaseline(
        parts.map((p) => p.id),
        parts,
      );
      const now = Date.now();
      await db.tests.update(testId, { reviewState: 'reviewed', partBaseline, reviewedAt: now });
      this.tests = this.tests.map((t) =>
        t.id === testId ? { ...t, reviewState: 'reviewed', partBaseline, reviewedAt: now } : t,
      );
    },
    /**
     * 失效流程成功后，仅同步本地工序/走时测试的失效标记（库内已由事务更新）。
     * 不写库，避免与零件更新事务重复。
     */
    applyInvalidation(clockId: string, partId: string) {
      this.items = this.items.map((s) =>
        s.clockId === clockId && s.partIds.includes(partId) && s.reviewState !== 'pending'
          ? { ...s, reviewState: 'pending' }
          : s,
      );
      this.tests = this.tests.map((t) =>
        t.clockId === clockId && t.reviewState !== 'pending' ? { ...t, reviewState: 'pending' } : t,
      );
    },
  },
});
