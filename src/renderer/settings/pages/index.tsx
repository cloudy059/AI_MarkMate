import type { ReactNode } from 'react'
import {
  AuditOutlined,
  CloudServerOutlined,
  FileTextOutlined,
  RocketOutlined,
  SaveOutlined
} from '@ant-design/icons'
import OnboardingPage from './Onboarding'
import { ModelsPage, MarkingPage } from './Merged'
import PresetsPage from './Presets'
import LogsPage from './Logs'

export interface SettingsPageDef {
  key: string
  label: string
  desc: string
  icon: ReactNode
  render: (go: (p: string) => void, page: string) => ReactNode
}

/**
 * 设置页注册表：侧边栏设置视图按此渲染菜单与详情页。
 * 合并页支持「key:分区」形式（如 models:providers 直达服务商分区）。
 */
export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    key: 'onboarding',
    label: '使用引导',
    desc: '四步上手流程与配置完成度自检',
    icon: <RocketOutlined />,
    render: (go) => <OnboardingPage go={go} />
  },
  {
    key: 'models',
    label: 'AI 服务商与模型',
    desc: '服务商接入 / 模型角色 / 全局规则',
    icon: <CloudServerOutlined />,
    render: (_go, page) => <ModelsPage section={parseSection(page)} />
  },
  {
    key: 'marking',
    label: '评分标准与答题区域',
    desc: '评分标准 / 分值配置 / 区域标记',
    icon: <AuditOutlined />,
    render: (_go, page) => <MarkingPage section={parseSection(page)} />
  },
  {
    key: 'presets',
    label: '预设方案',
    desc: '多套完整配置快照，一键切换',
    icon: <SaveOutlined />,
    render: () => <PresetsPage />
  },
  {
    key: 'logs',
    label: '批改日志',
    desc: '全链路识别 / 评分 / 提交数据',
    icon: <FileTextOutlined />,
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
    default:
      return p
  }
}

export function settingsPageByKey(key: string): SettingsPageDef | undefined {
  const base = key.split(':')[0]
  return SETTINGS_PAGES.find((p) => p.key === base)
}
