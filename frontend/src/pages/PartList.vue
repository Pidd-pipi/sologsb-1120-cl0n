<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import { useStepStore } from '../stores/stepStore';
import StateBadge from '../components/common/StateBadge.vue';
import {
  PART_DECISIONS,
  PART_NAMES,
  WEAR_STATES,
  type MovementPart,
  type MovementPartDraft,
  type PartDecision,
  type WearState,
} from '../types/part';

const clockStore = useClockStore();
const partStore = usePartStore();
const stepStore = useStepStore();

const wearFilter = ref<WearState | 'all'>('all');
const clockFilter = ref('all');
const onlyPending = ref(false);
const dialogVisible = ref(false);
const error = ref('');

const form = reactive<MovementPartDraft>({
  clockId: '',
  name: '发条',
  qtyNeeded: 1,
  position: '',
  wearState: '磨损',
  decision: '修配',
  sourceLot: '',
  dimension: 1,
});

/** 编辑对话框（多标签乐观锁：baseRevision 为打开时读到的零件版本） */
const editVisible = ref(false);
const editError = ref('');
const editingId = ref('');
const baseRevision = ref(0);
const saving = ref(false);
const editForm = reactive<MovementPartDraft>({
  clockId: '',
  name: '发条',
  qtyNeeded: 1,
  position: '',
  wearState: '磨损',
  decision: '修配',
  sourceLot: '',
  dimension: 1,
});

const rows = computed(() =>
  partStore.items.filter((p) => {
    if (wearFilter.value !== 'all' && p.wearState !== wearFilter.value) return false;
    if (clockFilter.value !== 'all' && p.clockId !== clockFilter.value) return false;
    if (onlyPending.value && !(p.decision !== '保留' && p.wearState !== '完好')) return false;
    return true;
  }),
);

const groups = computed(() =>
  WEAR_STATES.map((state) => ({ state, rows: rows.value.filter((p) => p.wearState === state) })),
);

const pendingCount = computed(
  () => partStore.items.filter((p) => p.decision !== '保留' && p.wearState !== '完好').length,
);

const staleStepCount = computed(() => stepStore.staleSteps.length);
const staleTestCount = computed(() => stepStore.staleTests.length);

/** 编辑期间其他页面已保存新版本（跨标签同步刷新本地缓存后触发），保存前提示重新载入 */
const editingOutdated = computed(() => {
  if (!editVisible.value || !editingId.value) return false;
  const row = partStore.items.find((it) => it.id === editingId.value);
  return row ? row.revision !== baseRevision.value : false;
});

function clockNo(clockId: string): string {
  return clockStore.byId(clockId)?.clockNo ?? '未知钟表';
}

function invalidationText(steps: number, tests: number): string {
  const bits: string[] = [];
  if (steps > 0) bits.push(`${steps} 道工序`);
  if (tests > 0) bits.push(`${tests} 次走时测试`);
  return bits.length ? `，${bits.join('、')}已标记待复核` : '';
}

/** 失效流程失败（已恢复原记录）后询问重试 */
async function confirmRetry(action: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(`${action}失败：关联失效处理未完成，已恢复原记录。是否重试？`, `${action}失败`, {
      type: 'error',
      confirmButtonText: '重试',
      cancelButtonText: '取消',
    });
    return true;
  } catch {
    return false;
  }
}

function openDialog() {
  dialogVisible.value = true;
  error.value = '';
  form.clockId = clockFilter.value !== 'all' ? clockFilter.value : clockStore.items[0]?.id ?? '';
}

async function submit() {
  if (!form.clockId) {
    error.value = '请选择所属钟表';
    return;
  }
  if (!form.position.trim()) {
    error.value = '装配位置必填';
    return;
  }
  try {
    const result = await partStore.add({
      ...form,
      position: form.position.trim(),
      sourceLot: form.sourceLot.trim(),
    });
    if (result.ok) {
      ElMessage.success(`已登记零件（r1）${invalidationText(result.invalidatedSteps, result.invalidatedTests)}`);
    }
    dialogVisible.value = false;
    form.position = '';
    form.sourceLot = '';
  } catch {
    if (await confirmRetry('登记')) await submit();
  }
}

function openEdit(row: MovementPart) {
  editingId.value = row.id;
  baseRevision.value = row.revision;
  editError.value = '';
  editForm.clockId = row.clockId;
  editForm.name = row.name;
  editForm.qtyNeeded = row.qtyNeeded;
  editForm.position = row.position;
  editForm.wearState = row.wearState;
  editForm.decision = row.decision;
  editForm.sourceLot = row.sourceLot;
  editForm.dimension = row.dimension;
  editVisible.value = true;
}

/** 载入最新版本：放弃本页未提交内容，以库中当前版本为新的编辑基准 */
function loadLatest() {
  const row = partStore.items.find((it) => it.id === editingId.value);
  if (!row) return;
  openEdit(row);
  ElMessage.info('已载入最新版本，请在此基础上修改');
}

async function saveEdit() {
  if (!editingId.value) return;
  if (!editForm.position.trim()) {
    editError.value = '装配位置必填';
    return;
  }
  saving.value = true;
  try {
    const result = await partStore.update(
      editingId.value,
      { ...editForm, position: editForm.position.trim(), sourceLot: editForm.sourceLot.trim() },
      baseRevision.value,
    );
    if (result.ok) {
      ElMessage.success(
        `已保存（版本 r${result.part.revision}）${invalidationText(result.invalidatedSteps, result.invalidatedTests)}`,
      );
      editVisible.value = false;
      return;
    }
    if (result.reason === 'conflict') {
      // 后保存页面不得覆盖先提交的版本：保留本页未提交内容，提示重新载入
      editError.value = `该零件刚在其他页面保存为 r${result.current.revision}，本次未覆盖。请「载入最新版本」后再保存；本页已填写的内容已保留。`;
      return;
    }
    editError.value = '零件不存在，可能已被删除';
  } catch {
    if (await confirmRetry('保存')) await saveEdit();
  } finally {
    saving.value = false;
  }
}

async function setDecision(id: string, decision: PartDecision) {
  const row = partStore.items.find((it) => it.id === id);
  try {
    const result = await partStore.update(id, { decision }, row?.revision);
    if (result.ok) {
      ElMessage.success(
        `处理决定已改为「${decision}」（r${result.part.revision}）${invalidationText(result.invalidatedSteps, result.invalidatedTests)}`,
      );
    } else if (result.reason === 'conflict') {
      ElMessage.warning('该零件已在其他页面被修改，已载入最新数据，请重新操作');
    } else {
      ElMessage.error('零件不存在，可能已被删除');
    }
  } catch {
    if (await confirmRetry('修改')) await setDecision(id, decision);
  }
}

async function removePart(row: MovementPart) {
  try {
    await ElMessageBox.confirm(
      `删除「${row.name} · ${row.position}」后，引用它的工序与本钟表走时测试将标记为待复核。确认删除？`,
      '删除零件',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    const result = await partStore.remove(row.id);
    if (result.ok) {
      ElMessage.success(`已删除${invalidationText(result.invalidatedSteps, result.invalidatedTests)}`);
    } else {
      ElMessage.error('零件不存在，可能已被删除');
    }
  } catch {
    if (await confirmRetry('删除')) await removePart(row);
  }
}

onMounted(async () => {
  await clockStore.load();
  await partStore.load();
  await stepStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>零件与配换清单</h2>
      <el-tag>共 {{ partStore.items.length }} 项</el-tag>
      <el-tag type="warning">待修配 {{ pendingCount }} 项</el-tag>
      <el-tag v-if="staleStepCount + staleTestCount > 0" type="danger">
        待复核：工序 {{ staleStepCount }} · 走时 {{ staleTestCount }}
      </el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="openDialog">登记零件</el-button>
    </div>

    <el-alert
      v-if="staleStepCount + staleTestCount > 0"
      type="warning"
      :closable="false"
      show-icon
      :title="`零件变动已使 ${staleStepCount} 道工序、${staleTestCount} 次走时测试失效，请前往钟表详情或走时测试页复核后再继续。`"
    />

    <el-card shadow="never">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="钟表">
          <el-select v-model="clockFilter" style="width: 220px">
            <el-option label="全部" value="all" />
            <el-option v-for="c in clockStore.items" :key="c.id" :label="c.clockNo" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="磨损状态">
          <el-select v-model="wearFilter" style="width: 140px">
            <el-option label="全部" value="all" />
            <el-option v-for="w in WEAR_STATES" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="onlyPending">只看待修配</el-checkbox>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-for="group in groups" :key="group.state" shadow="never">
      <template #header>
        <div class="card-head">
          <strong>{{ group.state }}</strong>
          <el-tag size="small" type="info">{{ group.rows.length }} 项</el-tag>
        </div>
      </template>
      <el-table :data="group.rows" size="small" border>
        <el-table-column label="钟表" width="150">
          <template #default="{ row }">{{ clockNo(row.clockId) }}</template>
        </el-table-column>
        <el-table-column prop="name" label="零件" width="110" />
        <el-table-column prop="qtyNeeded" label="数量" width="70" />
        <el-table-column prop="position" label="装配位置" min-width="150" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <StateBadge :label="row.wearState" :tone="row.wearState === '完好' ? 'success' : 'danger'" />
          </template>
        </el-table-column>
        <el-table-column label="处理决定" width="200">
          <template #default="{ row }">
            <el-radio-group :model-value="row.decision" size="small" @change="(v: unknown) => setDecision(row.id, String(v) as PartDecision)">
              <el-radio-button v-for="d in PART_DECISIONS" :key="d" :value="d">{{ d }}</el-radio-button>
            </el-radio-group>
          </template>
        </el-table-column>
        <el-table-column prop="sourceLot" label="配换来源批号" width="130" />
        <el-table-column prop="dimension" label="关键尺寸 mm" width="100" />
        <el-table-column label="版本" width="70" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">r{{ row.revision }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="待配" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.decision !== '保留' && row.wearState !== '完好'" type="warning" size="small">待修配</el-tag>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain @click="removePart(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="group.rows.length === 0" description="该状态暂无零件" :image-size="60" />
    </el-card>

    <el-dialog v-model="dialogVisible" title="登记零件" width="560px">
      <el-alert v-if="error" :title="error" type="error" :closable="false" style="margin-bottom: 10px" />
      <el-form :model="form" label-width="110px">
        <el-form-item label="所属钟表">
          <el-select v-model="form.clockId" style="width: 100%">
            <el-option v-for="c in clockStore.items" :key="c.id" :label="c.clockNo" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="零件名称">
          <el-select v-model="form.name" style="width: 100%">
            <el-option v-for="n in PART_NAMES" :key="n" :label="n" :value="n" />
          </el-select>
        </el-form-item>
        <el-form-item label="数量">
          <el-input-number v-model="form.qtyNeeded" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="装配位置" required>
          <el-input v-model="form.position" placeholder="如 二轮上下轴孔" />
        </el-form-item>
        <el-form-item label="磨损状态">
          <el-select v-model="form.wearState" style="width: 100%">
            <el-option v-for="w in WEAR_STATES" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item label="处理决定">
          <el-select v-model="form.decision" style="width: 100%">
            <el-option v-for="d in PART_DECISIONS" :key="d" :label="d" :value="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源批号">
          <el-input v-model="form.sourceLot" placeholder="如 MS-2024-07" />
        </el-form-item>
        <el-form-item label="关键尺寸 mm">
          <el-input-number v-model="form.dimension" :min="0" :max="200" :step="0.1" :precision="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editVisible" title="编辑零件" width="560px" :close-on-click-modal="false">
      <el-alert
        v-if="editingOutdated && !editError"
        title="该零件已在其他页面保存为新版本，保存前请先「载入最新版本」；本页未提交内容会保留。"
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 10px"
      />
      <el-alert v-if="editError" :title="editError" type="error" :closable="false" style="margin-bottom: 10px" />
      <el-form :model="editForm" label-width="110px">
        <el-form-item label="所属钟表">
          <el-input :model-value="clockNo(editForm.clockId)" disabled />
        </el-form-item>
        <el-form-item label="零件名称">
          <el-select v-model="editForm.name" style="width: 100%">
            <el-option v-for="n in PART_NAMES" :key="n" :label="n" :value="n" />
          </el-select>
        </el-form-item>
        <el-form-item label="数量">
          <el-input-number v-model="editForm.qtyNeeded" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="装配位置" required>
          <el-input v-model="editForm.position" />
        </el-form-item>
        <el-form-item label="磨损状态">
          <el-select v-model="editForm.wearState" style="width: 100%">
            <el-option v-for="w in WEAR_STATES" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item label="处理决定">
          <el-select v-model="editForm.decision" style="width: 100%">
            <el-option v-for="d in PART_DECISIONS" :key="d" :label="d" :value="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源批号">
          <el-input v-model="editForm.sourceLot" />
        </el-form-item>
        <el-form-item label="关键尺寸 mm">
          <el-input-number v-model="editForm.dimension" :min="0" :max="200" :step="0.1" :precision="2" />
        </el-form-item>
        <el-form-item label="编辑基准">
          <el-tag size="small" effect="plain">r{{ baseRevision }}</el-tag>
          <span class="hint">保存时若库中版本已变，将拒绝覆盖并提示重新载入</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button v-if="editingOutdated || editError" type="warning" plain @click="loadLatest">载入最新版本</el-button>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hint {
  margin-left: 10px;
  color: #7b8592;
  font-size: 13px;
}
</style>
