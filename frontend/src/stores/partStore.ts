import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { withRetry } from '../utils/retry';
import { VersionConflictError } from '../types/review';
import type { MovementPart, MovementPartDraft } from '../types/part';
import { useStepStore } from './stepStore';

interface PartState {
  items: MovementPart[];
  loaded: boolean;
}

/** 改动后会触发关联工序/走时测试失效重算的关键字段 */
const INVALIDATE_FIELDS = ['decision', 'dimension', 'sourceLot'] as const;

export const usePartStore = defineStore('part', {
  state: (): PartState => ({ items: [], loaded: false }),
  getters: {
    byClock: (state) => (clockId: string) => state.items.filter((it) => it.clockId === clockId),
    pendingRepair: (state) => state.items.filter((it) => it.decision !== '保留' && it.wearState !== '完好'),
  },
  actions: {
    async load() {
      this.items = await db.parts.toArray();
      this.loaded = true;
    },
    async add(draft: MovementPartDraft) {
      const now = Date.now();
      const record: MovementPart = { ...toPlain(draft), id: newId('prt'), version: 1, updatedAt: now };
      await db.parts.put(toPlain(record));
      this.items = [...this.items, record];
      return record;
    },
    async remove(id: string) {
      await db.parts.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
    },
    /**
     * 带乐观并发版本校验的零件更新。
     * - 若库内版本已领先于调用方持有的版本（其他标签页先提交），抛 VersionConflictError，
     *   不覆盖先提交的零件版本，由 UI 提示重新载入并保留本页未提交内容。
     * - 改动关键字段（处理决定 / 关键尺寸 / 来源批号）后，事务内联动：
     *   关联工序失效（待复核）、该钟全部走时测试失效（待复核）。
     * - 失效流程失败时回滚并重试；本地状态仅在事务成功后更新。
     */
    async update(id: string, patch: Partial<MovementPart>, expectedVersion?: number) {
      const current = await db.parts.get(id);
      if (!current) throw new Error('零件不存在或已被删除');
      const baseVersion = expectedVersion ?? current.version;
      if (current.version !== baseVersion) {
        throw new VersionConflictError(current);
      }

      // 剥离由 Store 管理的字段，避免外部传入覆盖
      const { version: _v, updatedAt: _u, ...rest } = patch;
      const plainPatch = toPlain(rest) as Partial<MovementPart>;
      const willInvalidate = INVALIDATE_FIELDS.some(
        (f) =>
          f in plainPatch &&
          (plainPatch as unknown as Record<string, unknown>)[f] !==
            (current as unknown as Record<string, unknown>)[f],
      );
      const now = Date.now();
      const nextVersion = current.version + 1;

      await withRetry(async () => {
        await db.transaction('rw', db.parts, db.steps, db.tests, async () => {
          await db.parts.update(id, { ...plainPatch, version: nextVersion, updatedAt: now });
          if (willInvalidate) {
            // 关联工序失效
            const steps = await db.steps.where('clockId').equals(current.clockId).toArray();
            for (const s of steps) {
              if (s.partIds.includes(id) && s.reviewState !== 'pending') {
                await db.steps.update(s.id, { reviewState: 'pending' });
              }
            }
            // 该钟全部走时测试失效
            const tests = await db.tests.where('clockId').equals(current.clockId).toArray();
            for (const t of tests) {
              if (t.reviewState !== 'pending') {
                await db.tests.update(t.id, { reviewState: 'pending' });
              }
            }
          }
        });
      });

      // 事务成功后同步本地状态
      this.items = this.items.map((it) =>
        it.id === id ? { ...it, ...plainPatch, version: nextVersion, updatedAt: now } : it,
      );
      if (willInvalidate) {
        useStepStore().applyInvalidation(current.clockId, id);
      }
    },
    /** 失效流程失败后，从库内重新载入本地记录，恢复原状态 */
    async reload() {
      this.items = await db.parts.toArray();
      this.loaded = true;
    },
    /** 从库内读取单个零件的最新记录并同步到本地（用于冲突后重新载入） */
    async fetchFresh(id: string) {
      const fresh = await db.parts.get(id);
      if (fresh) {
        this.items = this.items.map((it) => (it.id === id ? fresh : it));
      }
      return fresh;
    },
  },
});
