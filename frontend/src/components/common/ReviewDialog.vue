<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { db } from '../../utils/db';
import { useStepStore } from '../../stores/stepStore';
import { baselineForIds, baselineOf } from '../../utils/review';
import type { PartBaseline, ReviewTarget } from '../../types/review';

const props = defineProps<{
  modelValue: boolean;
  target: ReviewTarget | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'reviewed'): void;
}>();

interface Row {
  partId: string;
  name: string;
  /** 记录基准中的版本（null=记录基准里没有，属新增零件） */
  baseRevision: number | null;
  /** 当前版本（null=零件已删除） */
  currentRevision: number | null;
}

const stepStore = useStepStore();

const title = ref('');
const rows = ref<Row[]>([]);
/** 打开对话框时看到的零件版本快照，确认复核时据此做冲突检测 */
const seenBaseline = ref<PartBaseline>({});
const loading = ref(false);
const submitting = ref(false);

function close() {
  emit('update:modelValue', false);
}

/** 从库中读取最新零件版本，刷新对照表与冲突检测快照 */
async function prepare() {
  const target = props.target;
  if (!target) return;
  loading.value = true;
  try {
    if (target.kind === 'step') {
      const step = await db.steps.get(target.id);
      if (!step) {
        ElMessage.error('工序不存在，可能已被删除');
        close();
        return;
      }
      const parts = await db.parts.where('clockId').equals(step.clockId).toArray();
      title.value = `工序 #${step.seq} ${step.stepType}`;
      seenBaseline.value = baselineForIds(parts, step.partIds);
      rows.value = step.partIds.map((pid) => {
        const p = parts.find((it) => it.id === pid);
        return {
          partId: pid,
          name: p ? `${p.name} · ${p.position}` : '（零件已删除）',
          baseRevision: step.partBaseline[pid] ?? null,
          currentRevision: p ? p.revision : null,
        };
      });
    } else {
      const test = await db.tests.get(target.id);
      if (!test) {
        ElMessage.error('走时测试不存在，可能已被删除');
        close();
        return;
      }
      const parts = await db.parts.where('clockId').equals(test.clockId).toArray();
      title.value = `走时测试 ${new Date(test.testedAt).toLocaleString('zh-CN')}`;
      seenBaseline.value = baselineOf(parts);
      const list: Row[] = parts.map((p) => ({
        partId: p.id,
        name: `${p.name} · ${p.position}`,
        baseRevision: test.partBaseline[p.id] ?? null,
        currentRevision: p.revision,
      }));
      const alive = new Set(parts.map((p) => p.id));
      for (const pid of Object.keys(test.partBaseline)) {
        if (!alive.has(pid)) {
          list.push({ partId: pid, name: '（零件已删除）', baseRevision: test.partBaseline[pid], currentRevision: null });
        }
      }
      rows.value = list;
    }
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.modelValue, props.target] as const,
  ([visible, target]) => {
    if (visible && target) void prepare();
  },
);

async function confirm() {
  const target = props.target;
  if (!target) return;
  submitting.value = true;
  try {
    const result =
      target.kind === 'step'
        ? await stepStore.reviewStep(target.id, seenBaseline.value)
        : await stepStore.reviewTest(target.id, seenBaseline.value);
    if (result.ok) {
      ElMessage.success('已按当前零件基准复核，记录恢复有效');
      emit('reviewed');
      close();
      return;
    }
    if (result.reason === 'conflict') {
      // 复核期间零件又变过：保持待复核，载入最新版本让师傅重新核对
      await ElMessageBox.alert(
        '复核期间零件又有变动，本次复核未生效，记录保持「待复核」。已为你载入最新零件版本，请核对后再次复核。',
        '零件版本冲突',
        { type: 'warning', confirmButtonText: '知道了' },
      );
      await prepare();
      return;
    }
    ElMessage.error('记录不存在，可能已被删除');
    close();
  } catch {
    // 复核写库失败：reviewFlow 已恢复原记录，可重试
    let retry = false;
    try {
      await ElMessageBox.confirm('复核处理失败，已恢复原记录。是否重试？', '复核失败', {
        type: 'error',
        confirmButtonText: '重试',
        cancelButtonText: '稍后',
      });
      retry = true;
    } catch {
      retry = false;
    }
    if (retry) await confirm();
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="`复核 · ${title}`"
    width="640px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 12px"
      title="该记录因零件变动已失效。请核对下列零件当前版本：确认复核后记录恢复有效，并按当前版本重立复核基准。"
    />
    <el-table v-loading="loading" :data="rows" size="small" border>
      <el-table-column prop="name" label="零件" min-width="180" />
      <el-table-column label="记录基准" width="100" align="center">
        <template #default="{ row }">{{ row.baseRevision === null ? '—' : `r${row.baseRevision}` }}</template>
      </el-table-column>
      <el-table-column label="当前版本" width="100" align="center">
        <template #default="{ row }">{{ row.currentRevision === null ? '已删除' : `r${row.currentRevision}` }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag v-if="row.currentRevision === null" type="danger" size="small">已删除</el-tag>
          <el-tag v-else-if="row.baseRevision === null" type="info" size="small">新增</el-tag>
          <el-tag v-else-if="row.baseRevision !== row.currentRevision" type="warning" size="small">已变更</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">一致</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && rows.length === 0" description="无关联零件，确认后直接复核生效" :image-size="60" />
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="confirm">确认复核</el-button>
    </template>
  </el-dialog>
</template>
