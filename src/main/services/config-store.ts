import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { CURRENT_CONFIG_VERSION, type AppConfig } from '@shared/types'
import { defaultConfig } from '@main/ai/registry'

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** 递归合并：对象深合并，数组与标点整体替换 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(base) || Array.isArray(patch) || typeof base !== 'object' || typeof patch !== 'object') {
    return patch as T
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k]
    result[k] = b !== undefined && b !== null && typeof b === 'object' && !Array.isArray(b) && typeof v === 'object' && v !== null && !Array.isArray(v)
      ? deepMerge(b, v)
      : v
  }
  return result as T
}

class ConfigStore {
  private data!: AppConfig
  private filePath = ''
  private saveTimer: NodeJS.Timeout | null = null

  init(): void {
    const dir = app.getPath('userData')
    this.filePath = path.join(dir, 'config.json')
    this.data = this.load()
  }

  private load(): AppConfig {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        const saved = JSON.parse(raw) as Record<string, unknown>
        const merged = deepMerge(defaultConfig(), saved)
        merged.version = CURRENT_CONFIG_VERSION
        // 迁移：普通模式已移除，原 5 秒倒计时语义由无人值守倒计时承接
        if ((merged.workflow.gradingMode as string) === 'normal') {
          merged.workflow.gradingMode = 'unattended'
          const savedWf = (saved.workflow ?? {}) as Record<string, unknown>
          if (savedWf.unattendedDelaySec === undefined) merged.workflow.unattendedDelaySec = 5
        }
        // 迁移：简化服务商默认名称（去除公司名 / 本机后缀）；用户自定义过名称的不受影响
        const PROVIDER_NAME_MIGRATION: Record<string, string> = {
          '豆包（火山方舟）': '豆包',
          'Kimi（月之暗面）': 'Kimi',
          '自定义中转接口': '自定义接口',
          'Ollama（本机）': 'Ollama',
          'LM Studio（本机）': 'LM Studio'
        }
        for (const p of merged.providers) {
          const n = PROVIDER_NAME_MIGRATION[p.name]
          if (n) p.name = n
        }
        // 保证评分标准定长 10
        while (merged.scoringStandards.length < 10) merged.scoringStandards.push(null)
        merged.scoringStandards.length = 10
        merged.activeStandardIndex = Math.min(Math.max(merged.activeStandardIndex, 0), 9)
        return merged
      }
    } catch (err) {
      // 配置损坏：备份后使用默认配置
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      console.error('[config-store] 配置文件损坏，已使用默认配置', err)
    }
    return defaultConfig()
  }

  get(): AppConfig {
    return this.data
  }

  patch(partial: DeepPartial<AppConfig> | Record<string, unknown>): AppConfig {
    // regions 必须整体替换：区域对象含 phys/rect 等字段，深合并会让补丁中缺失的字段
    // （如被替换区域不再携带的旧 phys）复活，造成 rect 与 phys 指向不同位置的分裂状态
    if (
      partial &&
      typeof partial === 'object' &&
      'regions' in partial &&
      partial.regions &&
      typeof partial.regions === 'object' &&
      !Array.isArray(partial.regions)
    ) {
      const { regions, ...rest } = partial as Record<string, unknown>
      this.data = deepMerge(this.data, rest)
      this.data = { ...this.data, regions: regions as AppConfig['regions'] }
    } else {
      this.data = deepMerge(this.data, partial)
    }
    this.scheduleSave()
    return this.data
  }

  /** 整体替换（导入 / 应用预设） */
  replace(next: AppConfig): AppConfig {
    this.data = deepMerge(defaultConfig(), next)
    this.data.version = CURRENT_CONFIG_VERSION
    while (this.data.scoringStandards.length < 10) this.data.scoringStandards.push(null)
    this.data.scoringStandards.length = 10
    this.scheduleSave()
    return this.data
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, 300)
  }

  saveNow(): void {
    if (!this.filePath) return
    try {
      const dir = path.dirname(this.filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      fs.renameSync(tmp, this.filePath)
    } catch (err) {
      console.error('[config-store] 保存配置失败', err)
    }
  }
}

export const configStore = new ConfigStore()
