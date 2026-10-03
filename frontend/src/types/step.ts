import type { PartBaseline, ReviewState } from './review';

/** 维修步骤类型 */
export type StepType = '拆解' | '清洗' | '润滑' | '装配' | '调试' | '走时测试';

export const STEP_TYPES: StepType[] = ['拆解', '清洗', '润滑', '装配', '调试', '走时测试'];

/** 步骤状态 */
export type StepState = 'pending' | 'done' | 'rolledback';

/** 各步骤类型的动态字段开关 */
export const STEP_FIELD_MAP: Record<
  StepType,
  { needSolvent: boolean; needOil: boolean; needTorque: boolean }
> = {
  拆解: { needSolvent: false, needOil: false, needTorque: true },
  清洗: { needSolvent: true, needOil: false, needTorque: false },
  润滑: { needSolvent: false, needOil: true, needTorque: false },
  装配: { needSolvent: false, needOil: true, needTorque: true },
  调试: { needSolvent: false, needOil: false, needTorque: false },
  走时测试: { needSolvent: false, needOil: false, needTorque: false },
};

/** 维修工序 */
export interface RepairStep {
  id: string;
  clockId: string;
  stepType: StepType;
  /** 顺序号，不得跳号 */
  seq: number;
  /** 关联零件 */
  partIds: string[];
  /** 清洗液 */
  cleanSolvent: string;
  /** 清洗方式 */
  cleanMethod: string;
  /** 润滑油脂型号 */
  oilType: string;
  /** 润滑点位 */
  oilPoints: string;
  /** 拧紧力矩 N·m */
  torque: number;
  troubleNote: string;
  operator: string;
  startedAt: number;
  finishedAt?: number;
  state: StepState;
  /** 复核基准：关联零件 id → 复核/登记时的零件版本号 */
  partBaseline: PartBaseline;
  /** 复核状态：关联零件变动后工序失效，置为待复核 */
  reviewState: ReviewState;
}

export type RepairStepDraft = Omit<RepairStep, 'id' | 'partBaseline' | 'reviewState'>;
