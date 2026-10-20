import { useEffect, useMemo, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography
} from 'antd'
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import type { LogEntry } from '@shared/types'
import { useConfigStore } from '@renderer/stores/config'
import { useGradingStore } from '@renderer/stores/grading'
import { fmtTime } from '@renderer/utils'

const { Text, Title, Paragraph } = Typography

const PHASE_LABEL: Record<string, { label: string; color: string }> = {
  session: { label: '会话', color: 'purple' },
  capture: { label: '截题', color: 'blue' },
  ocr: { label: '识别', color: 'geekblue' },
  score: { label: '评分', color: 'green' },
  score2: { label: '双评', color: 'cyan' },
  parse: { label: '解析', color: 'gold' },
  submit: { label: '提交', color: 'orange' },
  state: { label: '状态', color: 'default' },
  region: { label: '区域', color: 'default' },
  automation: { label: '键鼠', color: 'default' },
  rubric: { label: '生成细则', color: 'geekblue' },
  app: { label: '应用', color: 'default' },
  ipc: { label: 'IPC', color: 'default' },
  preset: { label: '预设', color: 'purple' }
}

/** 批改日志：按天 JSONL 全链路数据（识别/评分/提交/得分） */
export default function LogsPage() {
  const { message } = AntdApp.useApp()
  const g = useGradingStore()
  const { config } = useConfigStore()
  const [dates, setDates] = useState<string[]>([])
  const [date, setDate] = useState<string | null>(null)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const refreshDates = async () => {
    try {
      const list = await window.api.listLogDates()
      setDates(list)
      setDate((d) => d ?? list[0] ?? null)
    } catch {
      /* ignore */
    }
  }

  const query = async () => {
    if (!date) return
    setLoading(true)
    try {
      const list = await window.api.queryLogs({ date })
      setEntries(list)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshDates()
  }, [])

  useEffect(() => {
    void query()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date])

  const sessions = useMemo(() => Array.from(new Set(entries.map((e) => e.sessionId))), [entries])
  const phases = useMemo(() => Array.from(new Set(entries.map((e) => e.phase))), [entries])
  const filtered = useMemo(
    () =>
      entries.filter(
        (e) => (!phase || e.phase === phase) && (!sessionId || e.sessionId === sessionId)
      ),
    [entries, phase, sessionId]
  )

  const columns = [
    {
      title: '时间',
      dataIndex: 'ts',
      width: 90,
      render: (v: number) => <Text style={{ fontSize: 11 }}>{fmtTime(v)}</Text>
    },
    {
      title: '序号',
      dataIndex: 'seq',
      width: 60,
      render: (v: number | undefined) => (v ? `#${v}` : '-')
    },
    {
      title: '阶段',
      dataIndex: 'phase',
      width: 80,
      render: (v: string) => {
        const p = PHASE_LABEL[v] ?? { label: v, color: 'default' }
        return <Tag color={p.color} style={{ fontSize: 11 }}>{p.label}</Tag>
      }
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 130,
      render: (v: string | undefined, r: LogEntry) => (
        <Text style={{ fontSize: 11 }}>
          {r.provider ? `${r.provider}/` : ''}
          {v ?? ''}
        </Text>
      )
    },
    {
      title: '延迟',
      dataIndex: 'latencyMs',
      width: 70,
      render: (v: number | undefined) => (v != null ? `${v}ms` : '')
    },
    {
      title: '分数',
      dataIndex: 'finalScore',
      width: 70,
      render: (v: number | undefined, r: LogEntry) =>
        v != null ? (
          <Text strong>{v}</Text>
        ) : (
          r.parsedScore != null ? <Text>{r.parsedScore}</Text> : ''
        )
    },
    {
      title: '详情 / 错误',
      render: (_: unknown, r: LogEntry) => (
        <Text
          type={r.error ? 'danger' : undefined}
          ellipsis={{ tooltip: r.error ?? r.detail ?? '' }}
          style={{ fontSize: 11, maxWidth: 260 }}
        >
          {r.error ?? r.detail ?? ''}
        </Text>
      )
    }
  ]

  return (
    <div>
      <Title level={4} className="page-title">
        批改日志
      </Title>
      <Paragraph className="page-desc">
        按天存储的全链路日志：识别、模型回复、分数解析、填写提交均可追溯；截图保存在 captures 子目录。
      </Paragraph>

      {/* 本次会话统计 */}
      {g.stats && (
        <Card size="small" style={{ marginBottom: 16 }} styles={{ body: { padding: '8px 20px' } }}>
          <Row gutter={16}>
            <Col span={8}>
              <Statistic title="本次已批" value={g.stats.total} valueStyle={{ fontSize: 18 }} />
            </Col>
            <Col span={8}>
              <Statistic title="已提交" value={g.stats.submitted} valueStyle={{ fontSize: 18 }} />
            </Col>
            <Col span={8}>
              <Statistic title="失败/跳过" value={g.stats.failed} valueStyle={{ fontSize: 18 }} />
            </Col>
            <Col span={8}>
              <Statistic title="人工仲裁" value={g.stats.arbitrated} valueStyle={{ fontSize: 18 }} />
            </Col>
            <Col span={8}>
              <Statistic title="平均分" value={g.stats.avgScore} precision={2} valueStyle={{ fontSize: 18 }} />
            </Col>
            <Col span={8}>
              <Statistic title="最高分" value={g.stats.maxScore} precision={2} valueStyle={{ fontSize: 18 }} />
            </Col>
          </Row>
        </Card>
      )}

      {/* 筛选工具栏 */}
      <Row gutter={[8, 8]} style={{ marginBottom: 8 }}>
        <Col span={12}>
          <Select
            placeholder="选择日期"
            value={date}
            onChange={(v) => setDate(v)}
            style={{ width: '100%' }}
            options={dates.map((d) => ({ label: d, value: d }))}
          />
        </Col>
        <Col span={12}>
          <Select
            placeholder="阶段（全部）"
            value={phase}
            onChange={setPhase}
            allowClear
            style={{ width: '100%' }}
            options={phases.map((p) => ({ label: PHASE_LABEL[p]?.label ?? p, value: p }))}
          />
        </Col>
        <Col span={24}>
          <Select
            placeholder="批改会话（全部）"
            value={sessionId}
            onChange={setSessionId}
            allowClear
            style={{ width: '100%' }}
            options={sessions.map((s) => ({ label: s, value: s }))}
          />
        </Col>
        <Col span={12}>
          <Button block icon={<ReloadOutlined />} onClick={() => void query()} loading={loading}>
            刷新
          </Button>
        </Col>
        <Col span={12}>
          <Button
            block
            icon={<FolderOpenOutlined />}
            onClick={() => {
              void window.api.openLogsFolder()
            }}
          >
            打开日志目录
          </Button>
        </Col>
      </Row>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        当前应用数据目录中的日志最多保留 30 天。
      </Text>

      <Table<LogEntry>
        size="small"
        rowKey={(r) => `${r.ts}-${r.seq}-${r.phase}`}
        columns={columns as never}
        dataSource={filtered}
        loading={loading}
        scroll={{ x: 720 }}
        pagination={{ pageSize: 50, showSizeChanger: false }}
        expandable={{
          expandedRowRender: (r) => (
            <Descriptions size="small" column={1} style={{ maxWidth: 900 }}>
              {r.ocrText && (
                <Descriptions.Item label="识别文本">
                  <div className="log-raw">{r.ocrText}</div>
                </Descriptions.Item>
              )}
              {r.rawResponse && (
                <Descriptions.Item label="模型原始回复">
                  <div className="log-raw">{r.rawResponse}</div>
                </Descriptions.Item>
              )}
              {r.imgHash && (
                <Descriptions.Item label="图像指纹">
                  <Text code>{r.imgHash}</Text>
                </Descriptions.Item>
              )}
              {r.state && (
                <Descriptions.Item label="批改状态">{r.state}</Descriptions.Item>
              )}
              {r.detail && (
                <Descriptions.Item label="详情">
                  <div className="log-raw">{r.detail}</div>
                </Descriptions.Item>
              )}
              {r.error && (
                <Descriptions.Item label="错误">
                  <Text type="danger">{r.error}</Text>
                </Descriptions.Item>
              )}
            </Descriptions>
          )
        }}
      />
      {config && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          提示：日志包含每题 AI 原始输出；如需核对某题截图，请到日志目录 captures/&lt;会话&gt;/ 下查看。
        </Text>
      )}
    </div>
  )
}
