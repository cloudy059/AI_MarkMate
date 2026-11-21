import type { ReactNode } from 'react'
import { ModelsPage, MarkingPage } from './Merged'
import PresetsPage from './Presets'
import LogsPage from './Logs'

export interface SettingsPageDef {
  key: string
  label: string
  render: (go: (p: string) => void, page: string) => ReactNode
}

/** 外部未指定页面时的兜底页（不再经过菜单列表） */
export const DEFAULT_SETTINGS_PAGE = 'marking:standards'

/**
 * 设置页注册表：主界面「前期设置 / 通用设置」入口按此打开对应设置页。
 * 合并页支持「key:分区」形式（如 models:providers 直达服务商分区）。
 */
export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    key: 'models',
    label: 'AI 服务商与模型',
    render: (_go, page) => <ModelsPage section={parseSection(page)} />
  },
  {
    key: 'marking',
    label: '评分标准与答题区域',
    render: (_go, page) => <MarkingPage section={parseSection(page)} />
  },
  {
    key: 'presets',
    label: '预设方案',
    render: () => <PresetsPage />
  },
  {
    key: 'logs',
    label: '批改日志',
    render: () => <LogsPage />
  }
]

/** 解析「key:分区」页键中的分区名 */
export function parseSection(page: string): string | undefined {
  const i = page.indexOf(':')
  return i >= 0 ? page.slice(i + 1) : undefined
}

/** 旧页键 → 合并页分区键（外部导航沿用旧键时自动映射） */
export function normalizeSettingsPage(p: string): string {
  switch (p) {
    case 'providers':
      return 'models:providers'
    case 'workflow':
      return 'models:workflow'
    case 'standards':
    case 'score':
      return 'marking:standards'
    case 'regions':
    case 'sub-questions':
    case 'subs-score':
      return 'marking:regions'
    // 旧引导页键回落到默认页
    case 'onboarding':
      return DEFAULT_SETTINGS_PAGE
    default:
      return p
  }
}

/** 兜底：未知页键回落到默认页，避免设置视图空白 */
export function ensureSettingsPage(p: string): string {
  return settingsPageByKey(p) ? p : DEFAULT_SETTINGS_PAGE
}

export function settingsPageByKey(key: string): SettingsPageDef | undefined {
  const base = key.split(':')[0]
  return SETTINGS_PAGES.find((p) => p.key === base)
}
