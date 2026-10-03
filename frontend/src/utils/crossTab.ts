/**
 * 多标签页数据同步：本页写库成功后广播，其他标签页收到后重新载入，
 * 让「先提交的零件版本」及时出现在别的页面上（配合保存时的版本校验）。
 */
const CHANNEL_NAME = 'gbclockrepair:sync';

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** 本页数据已变更，通知其他标签页重新载入 */
export function notifyDataChanged(): void {
  try {
    getChannel()?.postMessage({ at: Date.now() });
  } catch {
    /* 广播失败不影响本地写入 */
  }
}

/** 监听其他标签页的数据变更（不会收到本页自己的广播） */
export function onDataChanged(listener: () => void): void {
  const ch = getChannel();
  if (!ch) return;
  ch.onmessage = () => listener();
}
