/**
 * v2 → v3 迁移验证：先用旧版结构写入老记录，再用当前应用打开，
 * 检查零件版本号与复核基准是否补齐、老记录是否继续可用。
 * 运行：npx tsx scripts/verify-migration.ts
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

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
  // 1. 模拟旧版应用：v1 + v2 结构，写入不带版本/基准的老记录
  const old = new Dexie('gbclockrepair');
  old.version(1).stores({
    clocks: 'id, clockNo, kind, caliber, conditionGrade, createdAt',
    parts: 'id, clockId, name, wearState, decision',
    steps: 'id, clockId, seq, stepType, state',
    tests: 'id, clockId, testedAt',
  });
  old
    .version(2)
    .stores({
      clocks: 'id, clockNo, kind, caliber, conditionGrade, createdAt',
      parts: 'id, clockId, name, wearState, decision, sourceLot',
      steps: 'id, clockId, seq, stepType, state, startedAt',
      tests: 'id, clockId, testedAt, conclusion',
    })
    .upgrade(async (tx) => {
      await tx
        .table('steps')
        .toCollection()
        .modify((row: any) => {
          if (!row.state) row.state = 'pending';
          if (row.partIds === undefined) row.partIds = [];
          if (row.torque === undefined) row.torque = 0;
        });
      await tx
        .table('tests')
        .toCollection()
        .modify((row: any) => {
          if (row.positions === undefined) row.positions = [];
        });
    });
  await old.open();

  const now = Date.now();
  await old.table('clocks').put({
    id: 'clk_old',
    clockNo: 'CLK-OLD-001',
    kind: '座钟',
    caliber: 'Old 1.0',
    origin: '德国',
    maker: 'OldMaker',
    yearMade: '1910',
    caseMaterial: '木壳',
    size: '300×200×150',
    dialMark: '老盘',
    acquireFrom: '库房',
    conditionGrade: '三级',
    storagePos: 'A-1',
    createdAt: now,
  });
  await old.table('parts').put({
    id: 'prt_old',
    clockId: 'clk_old',
    name: '发条',
    qtyNeeded: 1,
    position: '条盒内',
    wearState: '磨损',
    decision: '修配',
    sourceLot: 'OLD-LOT',
    dimension: 0.4,
    // 无 revision / updatedAt
  });
  await old.table('steps').put({
    id: 'stp_old',
    clockId: 'clk_old',
    stepType: '拆解',
    seq: 1,
    partIds: ['prt_old'],
    cleanSolvent: '',
    cleanMethod: '',
    oilType: '',
    oilPoints: '',
    torque: 0.5,
    troubleNote: '',
    operator: '老师傅',
    startedAt: now,
    state: 'done',
    // 无 partBaseline / reviewState
  });
  await old.table('tests').put({
    id: 'tst_old',
    clockId: 'clk_old',
    testedAt: now,
    amplitude: 260,
    beatError: 0.5,
    rate: 8,
    positions: [],
    powerReserve: 40,
    conclusion: '合格',
    // 无 partBaseline / reviewState
  });
  old.close();

  // 2. 用当前应用（v3）打开同一数据库，触发迁移
  const { db } = await import('../src/utils/db');
  await db.open();

  const part = await db.parts.get('prt_old');
  const step = await db.steps.get('stp_old');
  const test = await db.tests.get('tst_old');

  console.log('v2 → v3 迁移');
  assert(part?.revision === 1, '零件补版本号 r1');
  assert(typeof part?.updatedAt === 'number', '零件补变动时间');
  assert(step?.reviewState === 'valid', '老工序保持有效可用');
  assert(step?.partBaseline?.prt_old === 1, '工序按当前零件补齐基准');
  assert(test?.reviewState === 'valid', '老走时测试保持有效可用');
  assert(test?.partBaseline?.prt_old === 1, '走时测试按本钟表零件补齐基准');

  // 3. 迁移后老记录可正常走复核流程
  const { applyPartUpdate, reviewStep } = await import('../src/utils/reviewFlow');
  const upd = await applyPartUpdate('prt_old', { sourceLot: 'NEW-LOT' }, 1);
  assert(upd.ok && upd.invalidatedSteps === 1 && upd.invalidatedTests === 1, '老零件可改动并触发失效');
  const rev = await reviewStep('stp_old', { prt_old: 2 });
  assert(rev.ok, '老工序复核通过');
  assert((await db.steps.get('stp_old'))?.reviewState === 'valid', '复核后恢复有效');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('验证脚本异常：', err);
  process.exit(1);
});
