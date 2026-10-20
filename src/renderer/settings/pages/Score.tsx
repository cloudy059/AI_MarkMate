import { App as AntdApp, Card, Col, InputNumber, Row, Typography } from 'antd'
import type { ScoreConfig } from '@shared/types'
import { useConfigStore } from '@renderer/stores/config'
import Hint from '@renderer/settings/Hint'

const { Text, Title, Paragraph } = Typography

/** 分值配置：整题总分 / 允许打分范围 / 步长精度 */
export default function ScorePage() {
  const { config, patch } = useConfigStore()
  const { message } = AntdApp.useApp()
  if (!config) return null
  const sc = config.scoreConfig

  const save = (p: Partial<ScoreConfig>) => {
    const next = { ...sc, ...p }
    const payload: Record<string, unknown> = { scoreConfig: next }
    // 总分值变化时同步平均分配到各小题（每题满分 = 总分值 ÷ 题数，0.5 步进取整）
    if (p.total !== undefined) {
      const enabled = config.subQuestions.filter((s) => s.enabled)
      if (enabled.length >= 2 && next.total > 0) {
        const perMax = Math.max(0.5, Math.round((next.total / enabled.length) * 2) / 2)
        const perStep = perMax % 1 === 0 ? 1 : 0.5
        payload.subQuestions = config.subQuestions.map((s) =>
          s.enabled ? { ...s, maxScore: perMax, step: perStep } : s
        )
      }
    }
    void patch(payload as never).catch((err: unknown) =>
      message.error(err instanceof Error ? err.message : String(err))
    )
  }

  const fieldLabel = { type: 'secondary' as const, style: { display: 'block', marginBottom: 4, fontSize: 12 } }

  return (
    <div>
      <Title level={4} className="page-title">
        分值配置
      </Title>
      <Paragraph className="page-desc">
        设置总分值、打分范围与步长；AI 给分自动对齐步长并夹取到范围内。
      </Paragraph>

      <Hint text="一键定位检测到多个分数输入框时自动分小题：总分值自动平均分配到各小题，评分标准统一引用整体评分标准。" />

      <Card styles={{ body: { padding: 14 } }}>
        <Row gutter={[12, 12]}>
          <Col span={12}>
            <Text {...fieldLabel}>总分值</Text>
            <InputNumber
              value={sc.total}
              onChange={(v) => save({ total: Number(v) || 0 })}
              min={0.5}
              max={1000}
              step={0.5}
              addonAfter="分"
              style={{ width: '100%' }}
            />
          </Col>
          <Col span={12}>
            <Text {...fieldLabel}>最低分</Text>
            <InputNumber
              value={sc.min}
              onChange={(v) => save({ min: Number(v) || 0 })}
              min={0}
              max={sc.max}
              step={0.5}
              addonAfter="分"
              style={{ width: '100%' }}
            />
          </Col>
          <Col span={12}>
            <Text {...fieldLabel}>最高分</Text>
            <InputNumber
              value={sc.max}
              onChange={(v) => save({ max: Number(v) || sc.total })}
              min={sc.min}
              max={1000}
              step={0.5}
              addonAfter="分"
              style={{ width: '100%' }}
            />
          </Col>
          <Col span={12}>
            <Text {...fieldLabel}>打分步长（精度）</Text>
            <InputNumber
              value={sc.step}
              onChange={(v) => save({ step: Math.abs(Number(v)) || 1 })}
              min={0}
              max={10}
              step={0.5}
              addonAfter="分"
              style={{ width: '100%' }}
            />
          </Col>
        </Row>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
          示例：范围 0~12、步长 1 时，AI 给出 11.7 分将自动修正为 12 分；给出 13 分将被夹取为 12 分。
        </Text>
      </Card>
    </div>
  )
}
