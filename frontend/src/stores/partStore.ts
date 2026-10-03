import { defineStore } from 'pinia';
import { db } from '../utils/db';
import {
  applyPartAdd,
  applyPartRemove,
  applyPartUpdate,
  type RemovePartResult,
  type SavePartResult,
} from '../utils/reviewFlow';
import { notifyDataChanged } from '../utils/crossTab';
import { useStepStore } from './stepStore';
import type { MovementPart, MovementPartDraft } from '../types/part';

interface PartState {
  items: MovementPart[];
  loaded: boolean;
}

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
    /** 登记零件：新零件进入复核基准，本钟表走时测试随之待复核 */
    async add(draft: MovementPartDraft): Promise<SavePartResult> {
      const result = await applyPartAdd(draft);
      await this.load();
      await useStepStore().load();
      notifyDataChanged();
      return result;
    },
    /**
     * 修改零件：版本号 +1，关联工序与本钟表走时测试失效待复核。
     * baseRevision 为编辑时读到的版本（多标签乐观锁）；
     * 冲突时不落库，本地缓存同步到最新，本页未提交内容由界面保留。
     */
    async update(id: string, patch: Partial<MovementPart>, baseRevision?: number): Promise<SavePartResult> {
      const result = await applyPartUpdate(id, patch, baseRevision);
      await this.load();
      if (result.ok) {
        await useStepStore().load();
        notifyDataChanged();
      }
      return result;
    },
    /** 删除零件：引用它的工序与本钟表走时测试失效待复核 */
    async remove(id: string): Promise<RemovePartResult> {
      const result = await applyPartRemove(id);
      await this.load();
      if (result.ok) {
        await useStepStore().load();
        notifyDataChanged();
      }
      return result;
    },
  },
});
