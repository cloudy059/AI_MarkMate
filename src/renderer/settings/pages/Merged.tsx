import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Segmented } from 'antd'
import WorkflowPage from './Workflow'
import StandardsPage from './Standards'
import RegionsPage from './Regions'
import ScorePage from './Score'

interface SectionDef {
  key: string
  label: string
  node: ReactNode
}

/**
 * 合并页通用容器：顶部分段切换 + 分区内容。
 * 各分区始终保持挂载（display 切换），保留编辑中的草稿与滚动状态。
 */
function MergedShell({ sections, section }: { sections: SectionDef[]; section?: string }) {
  const valid = sections.some((s) => s.key === section) ? (section as string) : sections[0].key
  const [active, setActive] = useState(valid)
  useEffect(() => {
    setActive(valid)
  }, [valid])

  return (
    <div>
      <Segmented
        block
        value={active}
        onChange={(v) => setActive(v as string)}
        options={sections.map((s) => ({ label: s.label, value: s.key }))}
        style={{ marginBottom: 12 }}
      />
      {sections.map((s) => (
        <div key={s.key} style={{ display: s.key === active ? 'block' : 'none' }}>
          {s.node}
        </div>
      ))}
    </div>
  )
}

/** 模型与评分标准（合并页）：模型与规则 + 评分标准 */
export function ModelsPage({ section }: { section?: string }) {
  return (
    <MergedShell
      section={section}
      sections={[
        { key: 'workflow', label: '模型与规则', node: <WorkflowPage /> },
        { key: 'standards', label: '评分标准', node: <StandardsPage /> }
      ]}
    />
  )
}

/** 答题区域与分值（单页）：分值配置在上、答题区域标记在下；分小题由一键定位/多次标记自动创建 */
export function MarkingPage() {
  return (
    <div>
      <ScorePage />
      <div style={{ marginTop: 16 }}>
        <RegionsPage />
      </div>
    </div>
  )
}
