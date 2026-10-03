/**
 * 复核基准流程的端到端逻辑验证（fake-indexeddb 模拟浏览器环境）。
 * 运行：npx tsx scripts/verify-review-flow.ts
 */
import 'fake-indexeddb/auto';
import { db, ensureSeedData } from '../src/utils/db';
import {
  applyPartAdd,
  applyPartRemove,
  applyPartUpdate,
  reviewStep,
  reviewTest,
} from '../src/utils/reviewFlow';
import { baselineForIds, baselineOf } from '../src/utils/review';

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

async function main() {
  await db.open();
  await ensureSeedData();

  const clockId = (await db.steps.toArray())[0].clockId; // 有工序的示范钟表
  const part = (await db.parts.where('clockId').equals(clockId).toArray())[0];
  const stepWithPart = (await db.steps.where('clockId').equals(clockId).toArray()).find((s) =>
    s.partIds.includes(part.id),
  )!;
  const test = (await db.tests.where('clockId').equals(clockId).toArray())[0];

  console.log('1. 种子数据带基准');
  assert(part.revision === 1, '零件初始版本 r1');
  assert(stepWithPart.reviewState === 'valid' && stepWithPart.partBaseline[part.id] === 1, '工序基准有效');
  assert(test.reviewState === 'valid' && test.partBaseline[part.id] === 1, '走时测试基准有效');

  console.log('2. 零件改动 → 关联工序与走时测试失效');
  const upd = await applyPartUpdate(part.id, { decision: '换新', sourceLot: 'MS-2025-01' }, 1);
  assert(upd.ok && upd.ok && upd.part.revision === 2, '保存成功，版本升到 r2');
  assert(upd.ok && upd.invalidatedSteps >= 1 && upd.invalidatedTests === 1, '失效计数正确');
  const stepAfter = await db.steps.get(stepWithPart.id);
  const testAfter = await db.tests.get(test.id);
  assert(stepAfter?.reviewState === 'stale', '关联工序已待复核');
  assert(testAfter?.reviewState === 'stale', '走时测试已待复核');

  console.log('3. 多标签乐观锁：旧版本保存被拒绝且不覆盖');
  const stale = await applyPartUpdate(part.id, { dimension: 9.99 }, 1);
  assert(!stale.ok && stale.reason === 'conflict', 'r1 旧版本保存冲突');
  const current = await db.parts.get(part.id);
  assert(current?.dimension !== 9.99 && current?.revision === 2, '先提交的 r2 未被覆盖');

  console.log('4. 复核冲突：复核期间零件又变过 → 保持待复核');
  const seen = baselineForIds(await db.parts.where('clockId').equals(clockId).toArray(), stepWithPart.partIds);
  await applyPartUpdate(part.id, { dimension: 0.4 }, 2); // 复核对话框打开后又有人改动 → r3
  const conflicted = await reviewStep(stepWithPart.id, seen);
  assert(!conflicted.ok && conflicted.reason === 'conflict', '复核检测到零件又变动');
  assert((await db.steps.get(stepWithPart.id))?.reviewState === 'stale', '工序保持待复核');

  console.log('5. 按最新基准复核成功');
  const seen2 = baselineForIds(await db.parts.where('clockId').equals(clockId).toArray(), stepWithPart.partIds);
  const ok = await reviewStep(stepWithPart.id, seen2);
  const stepReviewed = await db.steps.get(stepWithPart.id);
  assert(ok.ok && stepReviewed?.reviewState === 'valid', '工序复核通过');
  assert(stepReviewed?.partBaseline[part.id] === 3, '工序基准重立为 r3');

  console.log('6. 走时测试复核重算');
  const seenT = baselineOf(await db.parts.where('clockId').equals(clockId).toArray());
  const okT = await reviewTest(test.id, seenT);
  const testReviewed = await db.tests.get(test.id);
  assert(okT.ok && testReviewed?.reviewState === 'valid', '测试复核通过');
  assert(testReviewed?.partBaseline[part.id] === 3, '测试基准重立为 r3');
  assert(testReviewed?.conclusion === '合格', '结论按方位读数重算');

  console.log('7. 新增/删除零件使走时测试失效');
  const add = await applyPartAdd({
    clockId,
    name: '螺丝',
    qtyNeeded: 2,
    position: '摆夹板',
    wearState: '锈蚀',
    decision: '换新',
    sourceLot: 'SCR-01',
    dimension: 0.8,
  });
  assert(add.ok && add.invalidatedTests === 1, '新增零件后测试待复核');
  const newPartId = add.ok ? add.part.id : '';
  const rm = await applyPartRemove(newPartId);
  assert(rm.ok, '删除零件成功');
  assert((await db.parts.get(newPartId)) === undefined, '零件已删除');

  console.log('8. 失效流程失败 → 恢复原记录');
  const origStep = await db.steps.get(stepWithPart.id);
  const origTest = await db.tests.get(test.id);
  // 人为制造失败：猴子补丁让 steps 写库在事务中抛错
  const origUpdate = db.steps.update.bind(db.steps);
  (db.steps as any).update = () => Promise.reject(new Error('模拟写库失败'));
  let threw = false;
  try {
    await applyPartUpdate(part.id, { decision: '修配' }, 3);
  } catch {
    threw = true;
  }
  (db.steps as any).update = origUpdate;
  assert(threw, '失败流程抛出异常（上层可重试）');
  const partRestored = await db.parts.get(part.id);
  const stepRestored = await db.steps.get(stepWithPart.id);
  const testRestored = await db.tests.get(test.id);
  assert(partRestored?.revision === 3 && partRestored?.decision === '换新', '零件记录已恢复');
  assert(stepRestored?.reviewState === origStep?.reviewState, '工序状态已恢复');
  assert(testRestored?.reviewState === origTest?.reviewState, '测试状态已恢复');

  console.log('9. 重试成功');
  const retry = await applyPartUpdate(part.id, { decision: '修配' }, 3);
  assert(retry.ok && retry.ok && retry.part.revision === 4, '重试后保存成功，版本 r4');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('验证脚本异常：', err);
  process.exit(1);
});
