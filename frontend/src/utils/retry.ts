/**
 * 异步操作失败后重试。
 * 用于失效流程（零件改动 → 关联工序/走时测试失效）等需要原子性的写操作：
 * Dexie 事务本身会回滚，但本地状态可能与库内不一致，重试前由调用方重新载入。
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 50): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
