/** 生成短 ID */
export function genId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 带超时的 Promise */
export function withTimeout<T>(p: Promise<T>, ms: number, msg = '操作超时'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))
  ])
}
