import type { ReactNode } from 'react'
import {
  ApartmentOutlined,
  CloudServerOutlined,
  FileTextOutlined,
  RocketOutlined,
  SaveOutlined,
  SelectOutlined
} from '@ant-design/icons'
import OnboardingPage from './Onboarding'
import ProvidersPage from './Providers'
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
 * 合并页支持「key:分区」形式（如 models:standards 直达评分标准分区）。
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
    key: 'providers',
    label: 'AI 服务商',
    desc: '云端 / 本机 / 局域网模型接入与测试',
    icon: <CloudServerOutlined />,
    render: () => <ProvidersPage />
  },
  {
    key: 'models',
    label: '模型与评分标准',
    desc: '模型角色 / 全局规则 / 评分标准与细则',
    icon: <ApartmentOutlined />,
    render: (_go, page) => <ModelsPage section={parseSection(page)} />
  },
  {
    key: 'marking',
    label: '答题区域与分值',
    desc: '区域标记 / 一键定位 / 分值范围与步长',
    icon: <SelectOutlined />,
    render: () => <MarkingPage />
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
    case 'workflow':
      return 'models:workflow'
    case 'standards':
      return 'models:standards'
    case 'regions':
    case 'sub-questions':
    case 'subs-score':
    case 'score':
      return 'marking'
    default:
      return p
  }
}

export function settingsPageByKey(key: string): SettingsPageDef | undefined {
  const base = key.split(':')[0]
  return SETTINGS_PAGES.find((p) => p.key === base)
}
