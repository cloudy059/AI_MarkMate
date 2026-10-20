import { globalShortcut } from 'electron'
import { toggleSidebar } from '@main/windows'
import { logger } from '@main/services/logger'

let current = ''

/** 应用/更新侧边栏呼出快捷键 */
export function applyHotkey(accel: string): { ok: boolean; error?: string } {
  if (current) {
    try {
      globalShortcut.unregister(current)
    } catch {
      /* ignore */
    }
    current = ''
  }
  if (!accel) return { ok: true }
  try {
    globalShortcut.register(accel, () => toggleSidebar())
    current = accel
    return { ok: true }
  } catch (err) {
    const msg = `快捷键「${accel}」注册失败：${err instanceof Error ? err.message : String(err)}`
    logger.error({ phase: 'app', error: msg })
    return { ok: false, error: msg }
  }
}

export function unapplyHotkey(): void {
  applyHotkey('')
}
