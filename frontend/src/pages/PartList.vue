<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import StateBadge from '../components/common/StateBadge.vue';
import {
  PART_DECISIONS,
  PART_NAMES,
  WEAR_STATES,
  type MovementPart,
  type MovementPartDraft,
  type PartDecision,
  type PartName,
  type WearState,
} from '../types/part';
import { VersionConflictError } from '../types/review';

const clockStore = useClockStore();
const partStore = usePartStore();

const wearFilter = ref<WearState | 'all'>('all');
const clockFilter = ref('all');
const onlyPending = ref(false);
const dialogVisible = ref(false);
const dialogMode = ref<'add' | 'edit'>('add');
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

/** 编辑态：当前编辑的零件 id 与打开时的基准版本 */
const editingId = ref('');
const baseVersion = ref(0);
const editError = ref('');

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

function clockNo(clockId: string): string {
  return clockStore.byId(clockId)?.clockNo ?? '未知钟表';
}

function openAddDialog() {
  dialogMode.value = 'add';
  dialogVisible.value = true;
  error.value = '';
  editError.value = '';
  form.clockId = clockFilter.value !== 'all' ? clockFilter.value : clockStore.items[0]?.id ?? '';
}

async function submitAdd() {
  if (!form.clockId) {
    error.value = '请选择所属钟表';
    return;
  }
  if (!form.position.trim()) {
    error.value = '装配位置必填';
    return;
  }
  await partStore.add({
    ...form,
    position: form.position.trim(),
    sourceLot: form.sourceLot.trim(),
  });
  dialogVisible.value = false;
  ElMessage.success('已登记零件');
  form.position = '';
  form.sourceLot = '';
}

function openEditDialog(part: MovementPart) {
  dialogMode.value = 'edit';
  dialogVisible.value = true;
  editError.value = '';
  editingId.value = part.id;
  baseVersion.value = part.version;
  form.clockId = part.clockId;
  form.name = part.name;
  form.qtyNeeded = part.qtyNeeded;
  form.position = part.position;
  form.wearState = part.wearState;
  form.decision = part.decision;
  form.sourceLot = part.sourceLot;
  form.dimension = part.dimension;
}

async function submitEdit() {
  if (!form.position.trim()) {
    editError.value = '装配位置必填';
    return;
  }
  try {
    await partStore.update(
      editingId.value,
      {
        name: form.name,
        qtyNeeded: form.qtyNeeded,
        position: form.position.trim(),
        wearState: form.wearState,
        decision: form.decision,
        sourceLot: form.sourceLot.trim(),
        dimension: form.dimension,
      },
      baseVersion.value,
    );
    dialogVisible.value = false;
    ElMessage.success('零件信息已保存，关联工序与走时测试已失效重算');
  } catch (e) {
    if (e instanceof VersionConflictError) {
      // 冲突：保留本页未提交内容，提示重新载入
      editError.value = e.message;
    } else {
      throw e;
    }
  }
}

/** 重新载入当前编辑零件的库内最新版本（保留本页未提交内容，由用户选择是否覆盖） */
async function reloadEditPart() {
  const fresh = await partStore.fetchFresh(editingId.value);
  if (fresh) {
    baseVersion.value = fresh.version;
    editError.value = '';
    ElMessage.info('已重新载入最新版本，可再次保存');
  } else {
    await partStore.reload();
    editError.value = '零件已被删除';
  }
}

async function setDecision(row: MovementPart, decision: PartDecision) {
  try {
    await partStore.update(row.id, { decision }, row.version);
    ElMessage.success(`处理决定已改为「${decision}」`);
  } catch (e) {
    if (e instanceof VersionConflictError) {
      ElMessage.error(e.message);
      await partStore.reload();
    } else {
      throw e;
    }
  }
}

onMounted(async () => {
  await clockStore.load();
  await partStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>零件与配换清单</h2>
      <el-tag>共 {{ partStore.items.length }} 项</el-tag>
      <el-tag type="warning">待修配 {{ pendingCount }} 项</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="openAddDialog">登记零件</el-button>
    </div>

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
        <el-table-column prop="qtyNeeded" label="数量" width="80" />
        <el-table-column prop="position" label="装配位置" min-width="160" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <StateBadge :label="row.wearState" :tone="row.wearState === '完好' ? 'success' : 'danger'" />
          </template>
        </el-table-column>
        <el-table-column label="处理决定" width="200">
          <template #default="{ row }">
            <el-radio-group :model-value="row.decision" size="small" @change="(v: unknown) => setDecision(row, String(v) as PartDecision)">
              <el-radio-button v-for="d in PART_DECISIONS" :key="d" :value="d">{{ d }}</el-radio-button>
            </el-radio-group>
          </template>
        </el-table-column>
        <el-table-column prop="sourceLot" label="配换来源批号" width="150" />
        <el-table-column prop="dimension" label="关键尺寸 mm" width="120" />
        <el-table-column label="待配" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.decision !== '保留' && row.wearState !== '完好'" type="warning" size="small">待修配</el-tag>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openEditDialog(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="group.rows.length === 0" description="该状态暂无零件" :image-size="60" />
    </el-card>

    <el-dialog v-model="dialogVisible" :title="dialogMode === 'add' ? '登记零件' : '编辑零件'" width="560px">
      <el-alert v-if="error" :title="error" type="error" :closable="false" style="margin-bottom: 10px" />
      <el-alert
        v-if="editError"
        type="error"
        :closable="false"
        style="margin-bottom: 10px"
        data-testid="version-conflict-alert"
      >
        <template #title>
          <div class="conflict-alert">
            <span>{{ editError }}</span>
            <el-button size="small" type="primary" @click="reloadEditPart">重新载入</el-button>
          </div>
        </template>
      </el-alert>
      <el-form :model="form" label-width="110px">
        <el-form-item label="所属钟表">
          <el-select v-model="form.clockId" style="width: 100%" :disabled="dialogMode === 'edit'">
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
        <el-button type="primary" @click="dialogMode === 'add' ? submitAdd() : submitEdit()">保存</el-button>
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
.conflict-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
