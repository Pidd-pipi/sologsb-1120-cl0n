import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { baselineForIds, baselineOf } from '../utils/review';
import { reviewStep as flowReviewStep, reviewTest as flowReviewTest, type ReviewResult } from '../utils/reviewFlow';
import { notifyDataChanged } from '../utils/crossTab';
import type { RepairStep, RepairStepDraft } from '../types/step';
import type { TimekeepingTest, TimekeepingTestDraft } from '../types/test';
import type { PartBaseline } from '../types/review';
import type { RepairState } from '../types/clock';

interface StepState {
  items: RepairStep[];
  tests: TimekeepingTest[];
  loaded: boolean;
}

/** 工序是否按当前零件基准有效完成 */
function isDoneValid(step: RepairStep): boolean {
  return step.state === 'done' && step.reviewState === 'valid';
}

export const useStepStore = defineStore('step', {
  state: (): StepState => ({ items: [], tests: [], loaded: false }),
  getters: {
    byClock: (state) => (clockId: string) =>
      state.items.filter((it) => it.clockId === clockId).sort((a, b) => a.seq - b.seq),
    testsByClock: (state) => (clockId: string) =>
      state.tests.filter((it) => it.clockId === clockId).sort((a, b) => b.testedAt - a.testedAt),
    staleSteps: (state) => state.items.filter((it) => it.reviewState === 'stale'),
    staleTests: (state) => state.tests.filter((it) => it.reviewState === 'stale'),
    /** 单台钟表的复核后统计：完成数只计「有效」记录，台账/详情/走时单共用 */
    clockSummary: (state) => (clockId: string) => {
      const steps = state.items.filter((it) => it.clockId === clockId);
      const tests = state.tests.filter((it) => it.clockId === clockId);
      return {
        stepsTotal: steps.length,
        stepsDone: steps.filter(isDoneValid).length,
        stepsStale: steps.filter((it) => it.reviewState === 'stale').length,
        testsTotal: tests.length,
        testsValid: tests.filter((it) => it.reviewState === 'valid').length,
        testsStale: tests.filter((it) => it.reviewState === 'stale').length,
      };
    },
    /** 由工序与走时测试推导修复状态（按复核后的有效结果），用于台账分栏 */
    repairStateOf: (state) => (clockId: string): RepairState => {
      const steps = state.items.filter((it) => it.clockId === clockId);
      const tests = state.tests.filter((it) => it.clockId === clockId);
      if (steps.length === 0) return '未开工';
      const doneValid = steps.filter(isDoneValid).length;
      const hasStale =
        steps.some((it) => it.reviewState === 'stale') || tests.some((it) => it.reviewState === 'stale');
      if (doneValid === steps.length && !hasStale) {
        return tests.some((it) => it.reviewState === 'valid') ? '已完成' : '待测试';
      }
      if (doneValid > 0 || steps.some((it) => it.state === 'done')) return '维修中';
      return '未开工';
    },
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
      const clockParts = await db.parts.where('clockId').equals(draft.clockId).toArray();
      const record: RepairStep = {
        ...toPlain(draft),
        id: newId('stp'),
        partBaseline: baselineForIds(clockParts, draft.partIds),
        reviewState: 'valid',
      };
      await db.steps.put(toPlain(record));
      this.items = [...this.items, record];
      notifyDataChanged();
      return record;
    },
    async finish(id: string) {
      const patch: Partial<RepairStep> = { state: 'done', finishedAt: Date.now() };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
      notifyDataChanged();
    },
    async rollback(id: string) {
      const patch: Partial<RepairStep> = { state: 'rolledback', finishedAt: undefined };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
      notifyDataChanged();
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
      notifyDataChanged();
    },
    async addTest(draft: TimekeepingTestDraft) {
      const clockParts = await db.parts.where('clockId').equals(draft.clockId).toArray();
      const record: TimekeepingTest = {
        ...toPlain(draft),
        id: newId('tst'),
        partBaseline: baselineOf(clockParts),
        reviewState: 'valid',
      };
      await db.tests.put(toPlain(record));
      this.tests = [record, ...this.tests];
      notifyDataChanged();
      return record;
    },
    async removeTest(id: string) {
      await db.tests.delete(id);
      this.tests = this.tests.filter((it) => it.id !== id);
      notifyDataChanged();
    },
    /** 复核工序：零件又变过则冲突并保持待复核，否则重立基准恢复有效 */
    async reviewStep(id: string, seenBaseline: PartBaseline): Promise<ReviewResult> {
      const result = await flowReviewStep(id, seenBaseline);
      if (result.ok) {
        await this.load();
        notifyDataChanged();
      }
      return result;
    },
    /** 复核走时测试：通过则按方位读数重算均值与结论 */
    async reviewTest(id: string, seenBaseline: PartBaseline): Promise<ReviewResult> {
      const result = await flowReviewTest(id, seenBaseline);
      if (result.ok) {
        await this.load();
        notifyDataChanged();
      }
      return result;
    },
  },
});
