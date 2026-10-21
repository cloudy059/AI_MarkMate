import { App as AntdApp, Card, Col, Input, InputNumber, Row, Segmented, Select, Tag, Typography } from 'antd'
import type { ReactNode } from 'react'
import type { ProviderRef, WorkflowConfig } from '@shared/types'
import { useConfigStore } from '@renderer/stores/config'
import { isLocalKind } from '@renderer/utils'
import Hint from '@renderer/settings/Hint'

const { Text, Title, Paragraph } = Typography

/** 紧凑小节标题：替代 Title level={5}（默认 16px 上下边距过大） */
const SectionLabel = ({ children }: { children: ReactNode }) => (
  <Text strong style={{ fontSize: 13, display: 'block' }}>
    {children}
  </Text>
)

export const MODE_DESC: Record<string, string> = {
  A: '整图直接提交多模态模型，一步完成识别与评分；适配字迹潦草、含公式图表的主观题。',
  B: '本机识图模型提取文字与 LaTeX 后再评分，全程数据不出本地。',
  C: '云端识图模型识别后再评分，适配本地算力不足的批量场景。'
}

export const GRADING_MODE_DESC: Record<string, string> = {
  trial: '每题评分后等待人工确认再提交（首次使用推荐）',
  unattended: '评分后倒计时自动提交（时长可在主页「批改模式」卡片调整，默认 0 秒直接提交），适合大批量挂机',
  double: '两个独立模型分别评分取平均，分差超阈值触发人工仲裁；评分后倒计时自动提交（默认 5 秒，可在主页「批改模式」卡片调整）'
}

/** 模型与规则配置：评分 / 识别 / 双评第二模型来源、全局评分规则 */
export default function WorkflowPage() {
  const { config, patch } = useConfigStore()
  const { message } = AntdApp.useApp()
  if (!config) return null
  const wf = config.workflow

  const save = (p: Partial<WorkflowConfig>) => {
    patch({ workflow: p } as never).catch((err: unknown) =>
      message.error(err instanceof Error ? err.message : String(err))
    )
  }

  return (
    <div>
      <Title level={4} className="page-title">
        模型与规则
      </Title>
      <Paragraph className="page-desc">
        配置评分 / 识别 / 双评第二模型来源与全局评分规则；修改即时保存并对下一次评分请求生效。
      </Paragraph>

      {/* 角色模型 */}
      <Card title="评分与识别模型" styles={{ body: { padding: '10px 12px' } }}>
        <SectionLabel>识别评分模式</SectionLabel>
        <Segmented
          block
          value={wf.mode}
          onChange={(v) => save({ mode: v as WorkflowConfig['mode'] })}
          options={[
            { label: '多模态直评', value: 'A' },
            { label: '本机OCR', value: 'B' },
            { label: '云端OCR', value: 'C' }
          ]}
        />
        <div style={{ marginTop: 4 }}>
          <Hint text={MODE_DESC[wf.mode]} />
        </div>

        <div style={{ marginTop: 10 }}>
          <SectionLabel>评分模型（主）</SectionLabel>
          {wf.mode === 'A' && (
            <Hint text="评分模型需具备视觉能力（可在下方覆盖指定多模态模型）。" />
          )}
          <RefEditor
            value={wf.roles.grader}
            purpose={wf.mode === 'A' ? 'vision' : 'chat'}
            onChange={(v) => save({ roles: { ...wf.roles, grader: v ?? wf.roles.grader } })}
            placeholderModel={wf.mode === 'A' ? '留空使用服务商多模态模型' : '留空使用服务商文本评分模型'}
          />
        </div>

        {wf.mode !== 'A' && (
          <div style={{ marginTop: 10 }}>
            <SectionLabel>识别（OCR）模型</SectionLabel>
            <RefEditor
              value={wf.roles.ocr}
              purpose="ocr"
              onChange={(v) => save({ roles: { ...wf.roles, ocr: v } })}
              placeholderModel="留空使用服务商 OCR / 多模态模型"
            />
          </div>
        )}

        <div style={{ marginTop: 10 }}>
          <SectionLabel>双评第二模型</SectionLabel>
          <Hint text="仅双评模式使用；两个模型需相互独立。" />
          <RefEditor
            value={wf.roles.grader2}
            purpose={wf.mode === 'A' ? 'vision' : 'chat'}
            allowEmpty
            onChange={(v) => save({ roles: { ...wf.roles, grader2: v } })}
            placeholderModel="留空使用服务商默认模型"
          />
        </div>
      </Card>

      {/* 其他参数 */}
      <Card title="批改节奏与全局规则" style={{ marginTop: 10 }} styles={{ body: { padding: '10px 12px' } }}>
        <Row gutter={24} align="middle">
          <Col>
            <Text>提交后等待翻页时间：</Text>
            <InputNumber
              style={{ marginLeft: 8 }}
              value={wf.nextDelayMs / 1000}
              onChange={(v) => save({ nextDelayMs: Math.max(0.5, Number(v) || 2) * 1000 })}
              min={0.5}
              max={60}
              step={0.5}
              addonAfter="秒"
            />
          </Col>
        </Row>
        <div style={{ marginTop: 10 }}>
          <SectionLabel>全局评分规则 Prompt</SectionLabel>
          <Hint text="全局打分规则与约束（支持 Markdown / LaTeX），随每题发送（含分小题场景）。" />
          <Input.TextArea
            value={wf.rulesPrompt}
            onChange={(e) => save({ rulesPrompt: e.target.value })}
            rows={4}
            style={{ marginTop: 4 }}
            placeholder="例：你是一位严谨且经验丰富的阅卷老师……错别字不扣分；结果正确但过程缺失时给一半分……"
          />
        </div>
      </Card>
    </div>
  )
}

// ---------------- 角色模型编辑器 ----------------

function RefEditor({
  value,
  onChange,
  purpose,
  allowEmpty,
  placeholderModel
}: {
  value: ProviderRef | null
  onChange: (v: ProviderRef | null) => void
  purpose: 'chat' | 'vision' | 'ocr'
  allowEmpty?: boolean
  placeholderModel: string
}) {
  const { config } = useConfigStore()
  if (!config) return null

  const cloud = config.providers.filter((p) => !isLocalKind(p.kind))
  const local = config.providers.filter((p) => isLocalKind(p.kind))
  const source = value?.source ?? (allowEmpty ? 'none' : 'cloud')
  const label = purpose === 'ocr' ? 'OCR/识图' : purpose === 'vision' ? '多模态' : '文本'

  const providerOptions = (list: typeof config.providers) =>
    list.map((p) => ({
      label: `${p.name}${p.enabled ? '' : '（未启用）'}`,
      value: p.id
    }))

  return (
    <div style={{ padding: '2px 0 0' }}>
      <Segmented
        block
        value={source === 'none' ? 'none' : source}
        onChange={(v) => {
          const s = v as string
          if (s === 'none') onChange(null)
          else if (s === 'cloud') onChange({ source: 'cloud', providerId: cloud[0]?.id })
          else if (s === 'local') onChange({ source: 'local', providerId: local[0]?.id })
          else if (s === 'lan') onChange({ source: 'lan', lanNodeId: config.lanNodes[0]?.id ?? '' })
        }}
        options={[
          ...(allowEmpty ? [{ label: '不使用', value: 'none' }] : []),
          { label: '云端', value: 'cloud' },
          { label: '本机', value: 'local' },
          { label: '局域网', value: 'lan' }
        ]}
      />

      {source === 'cloud' && (
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          <Select2 options={providerOptions(cloud)} value={value?.providerId ?? ''} onChange={(v) => onChange({ ...value, source: 'cloud', providerId: v, lanNodeId: undefined } as ProviderRef)} style={{ width: '100%' }} />
          <Input
            style={{ width: '100%' }}
            placeholder={placeholderModel}
            value={value?.model ?? ''}
            onChange={(e) => onChange({ ...value, source: 'cloud', providerId: value?.providerId, model: e.target.value } as ProviderRef)}
          />
        </div>
      )}

      {source === 'local' && (
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          <Select2 options={providerOptions(local)} value={value?.providerId ?? ''} onChange={(v) => onChange({ ...value, source: 'local', providerId: v, lanNodeId: undefined } as ProviderRef)} style={{ width: '100%' }} />
          <Input
            style={{ width: '100%' }}
            placeholder={placeholderModel}
            value={value?.model ?? ''}
            onChange={(e) => onChange({ ...value, source: 'local', providerId: value?.providerId, model: e.target.value } as ProviderRef)}
          />
        </div>
      )}

      {source === 'lan' && (
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          {config.lanNodes.length === 0 ? (
            <Tag color="warning">尚未添加局域网节点，请先到「AI 服务商」页添加</Tag>
          ) : (
            <Select2
              options={config.lanNodes.map((n) => ({ label: `${n.name}${n.health.ok ? '' : '（未连通）'}${n.enabled ? '' : '（停用）'}`, value: n.id }))}
              value={value?.lanNodeId ?? ''}
              onChange={(v) => onChange({ source: 'lan', lanNodeId: v, model: value?.model } as ProviderRef)}
              style={{ width: '100%' }}
            />
          )}
          <Input
            style={{ width: '100%' }}
            placeholder="必填：节点上的具体模型名"
            value={value?.model ?? ''}
            onChange={(e) => onChange({ source: 'lan', lanNodeId: value?.lanNodeId, model: e.target.value } as ProviderRef)}
          />
        </div>
      )}

      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 3 }}>
        （{label}用途）
      </Text>
    </div>
  )
}

/** Select 二次封装（受控） */
function Select2({
  options,
  value,
  onChange,
  style
}: {
  options: { label: string; value: string }[]
  value: string
  onChange: (v: string) => void
  style?: React.CSSProperties
}) {
  return (
    <Select
      style={style}
      size="middle"
      value={value || undefined}
      options={options}
      onChange={(v) => onChange(v)}
      popupMatchSelectWidth={false}
    />
  )
}
