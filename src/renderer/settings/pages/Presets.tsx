import { useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography
} from 'antd'
import { CheckCircleOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import type { Preset } from '@shared/types'
import { useConfigStore } from '@renderer/stores/config'
import { fmtDateTime, genId } from '@renderer/utils'
import Hint from '@renderer/settings/Hint'

const { Text, Title, Paragraph } = Typography

/** 预设方案管理：多套完整配置方案（快照），一键切换/按题型学科自动匹配 */
export default function PresetsPage() {
  const { config, patch } = useConfigStore()
  const { message } = AntdApp.useApp()
  const [modal, setModal] = useState<Preset | null>(null)

  if (!config) return null
  const presets = config.presets

  /** 从当前配置生成快照 */
  const snapshotOf = (): Preset['snapshot'] => ({
    workflow: config.workflow,
    scoreConfig: config.scoreConfig,
    subQuestions: config.subQuestions,
    scoringStandards: config.scoringStandards,
    activeStandardIndex: config.activeStandardIndex
  })

  const saveList = (list: Preset[]) => {
    void patch({ presets: list }).catch((err: unknown) =>
      message.error(err instanceof Error ? err.message : String(err))
    )
  }

  const savePreset = (p: Preset) => {
    const exists = presets.some((x) => x.id === p.id)
    saveList(
      exists
        ? presets.map((x) => (x.id === p.id ? p : x))
        : [...presets, { ...p, snapshot: Object.keys(p.snapshot).length > 0 ? p.snapshot : snapshotOf() }]
    )
  }

  const applyPreset = async (p: Preset) => {
    await patch(p.snapshot)
    void message.success(`已应用预设方案「${p.name}」`)
  }

  const newPreset = (): Preset => ({
    id: genId('preset'),
    name: '',
    matchRules: { questionTypes: [], subjects: [] },
    snapshot: snapshotOf(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  })

  const summary = (p: Preset): string => {
    const wf = p.snapshot.workflow
    const sc = p.snapshot.scoreConfig
    const parts: string[] = []
    if (wf) parts.push(`${wf.mode === 'A' ? '多模态直评' : wf.mode === 'B' ? '本机OCR' : '云端OCR'} · ${wf.gradingMode === 'normal' ? '普通' : wf.gradingMode === 'trial' ? '试改' : wf.gradingMode === 'unattended' ? '无人值守' : '双评'}`)
    if (sc) parts.push(`总分 ${sc.total}`)
    if (p.snapshot.subQuestions?.length) parts.push(`${p.snapshot.subQuestions.length} 个小题`)
    return parts.join(' · ')
  }

  return (
    <div>
      <Title level={4} className="page-title">
        预设方案管理
      </Title>
      <Paragraph className="page-desc">
        保存多套完整配置方案（工作流 / 分值 / 小题 / 评分标准）一键切换；可按题型/学科自动匹配。
      </Paragraph>

      <Hint text="新建预设抓取当前配置快照；应用预设会立即覆盖当前配置；开始批改时按评分标准的题型/学科自动匹配。" />

      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => setModal(newPreset())}
        style={{ marginBottom: 16 }}
      >
        新建预设（抓取当前配置）
      </Button>

      {presets.length === 0 ? (
        <Empty description="暂无预设方案" />
      ) : (
        <List
          dataSource={presets}
          renderItem={(p) => (
            <List.Item style={{ display: 'block' }}>
              <List.Item.Meta
                title={
                  <Space size={6} wrap>
                    <Text strong>{p.name}</Text>
                    {p.matchRules.questionTypes.map((t) => (
                      <Tag key={t} color="blue">
                        题型：{t}
                      </Tag>
                    ))}
                    {p.matchRules.subjects.map((s) => (
                      <Tag key={s} color="geekblue">
                        学科：{s}
                      </Tag>
                    ))}
                  </Space>
                }
                description={
                  <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                    {summary(p)} · 更新于 {fmtDateTime(p.updatedAt)}
                  </Text>
                }
              />
              <Space size={8} style={{ marginTop: 4 }}>
                <Button size="small" type="primary" icon={<CheckCircleOutlined />} onClick={() => void applyPreset(p)}>
                  应用
                </Button>
                <Button size="small" icon={<EditOutlined />} onClick={() => setModal({ ...p, matchRules: { ...p.matchRules } })}>
                  编辑
                </Button>
                <Popconfirm
                  title="删除该预设？"
                  onConfirm={() => saveList(presets.filter((x) => x.id !== p.id))}
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            </List.Item>
          )}
        />
      )}

      {/* 编辑/新建弹窗 */}
      <Modal
        title={config.presets.some((x) => x.id === modal?.id) ? '编辑预设' : '新建预设'}
        open={!!modal}
        onCancel={() => setModal(null)}
        onOk={() => {
          if (!modal) return
          if (!modal.name.trim()) {
            void message.warning('请填写预设名称')
            return
          }
          savePreset({ ...modal, updatedAt: Date.now() })
          setModal(null)
          void message.success('已保存')
        }}
        okText="保存"
        width="94%"
        destroyOnClose
      >
        {modal && (
          <PresetForm preset={modal} onChange={(p) => setModal(p)} />
        )}
      </Modal>

      {/* 导入导出 */}
      <Card size="small" style={{ marginTop: 24 }} title="导入 / 导出" styles={{ body: { padding: '8px 16px' } }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          全部配置（含全部预设方案与密钥）可通过侧边栏设置菜单底部的「导出配置 / 导入配置」按钮导出 JSON 或导入，便于在不同电脑之间迁移。
        </Text>
      </Card>
    </div>
  )
}

function PresetForm({ preset, onChange }: { preset: Preset; onChange: (p: Preset) => void }) {
  return (
    <Form layout="vertical">
      <Form.Item label="预设名称" required>
        <Input
          value={preset.name}
          onChange={(e) => onChange({ ...preset, name: e.target.value })}
          placeholder="例：解三角形大题标准方案"
        />
      </Form.Item>
      <Form.Item label="自动匹配 · 题型（可选，多个）" extra="当前评分标准的题型命中任一填写值时自动应用（留空表示不按题型匹配）">
        <Select
          mode="tags"
          value={preset.matchRules.questionTypes}
          onChange={(v) => onChange({ ...preset, matchRules: { ...preset.matchRules, questionTypes: v } })}
          placeholder="例：解答题、应用题（回车确认）"
        />
      </Form.Item>
      <Form.Item label="自动匹配 · 学科（可选，多个）" extra="留空表示不按学科匹配；题型与学科需同时命中才触发">
        <Select
          mode="tags"
          value={preset.matchRules.subjects}
          onChange={(v) => onChange({ ...preset, matchRules: { ...preset.matchRules, subjects: v } })}
          placeholder="例：数学、物理（回车确认）"
        />
      </Form.Item>
      <Alert
        type="info"
        showIcon
        message={`该预设保存的快照内容：${preset.snapshot.workflow ? '工作流 ' : ''}${preset.snapshot.scoreConfig ? '分值 ' : ''}${preset.snapshot.subQuestions ? `小题(${preset.snapshot.subQuestions.length}) ` : ''}${preset.snapshot.scoringStandards ? '评分标准 ' : ''}`}
      />
    </Form>
  )
}
