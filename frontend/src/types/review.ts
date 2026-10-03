/** 复核状态：valid=按当前零件基准有效；stale=零件变动后失效，待复核 */
export type ReviewState = 'valid' | 'stale';

export const REVIEW_STATES: ReviewState[] = ['valid', 'stale'];

export const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  valid: '有效',
  stale: '待复核',
};

/** 复核基准：零件 id → 复核时的零件版本号 */
export type PartBaseline = Record<string, number>;

/** 复核对象：工序或走时测试 */
export interface ReviewTarget {
  kind: 'step' | 'test';
  id: string;
}
