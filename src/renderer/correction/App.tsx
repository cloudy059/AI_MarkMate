import { useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Collapse,
  Descriptions,
  Input,
  InputNumber,
  Space,
  Spin,
  Steps,
  Tabs,
  Tag,
  Typography
} from 'antd'
import {
  ArrowLeftOutlined,
  CheckOutlined,
  CloseOutlined,
  ExperimentOutlined,
  HighlightOutlined,
  SafetyOutlined
} from '@ant-design/icons'
import type { CorrectionAnalysisSections, CorrectionInitPayload } from '@shared/types'
import { Markdown } from '@renderer/components/Markdown'

const { Text, Paragraph } = Typography

type Step = 'feedback' | 'analysis' | 'review'

/** 评分理由编辑器：左侧 Markdown 编辑 + 右侧实时预览，支持 AI 润色（流式回填） */
function ReasonEditor({
  value,
  onChange,
  polishing,
  onPolish,
  rows
}: {
  value: string
  onChange: (v: string) => void
  polishing: boolean
  onPolish: () => void
  rows?: number
}) {
  return (
    <div className="reason-editor">
      <div className="reason-edit-col">
        <Input.TextArea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoSize={{ minRows: rows ?? 5, maxRows: (rows ?? 5) + 6 }}
          placeholder="评分理由（支持 Markdown 与 LaTeX 公式），修改后将随分数一起提交并记入评阅历史"
          disabled={polishing}
        />
        <Button
          size="small"
          icon={<HighlightOutlined />}
          onClick={onPolish}
          loading={polishing}
          style={{ marginTop: 6, alignSelf: 'flex-start' }}
        >
          AI 润色
        </Button>
      </div>
      <div className="reason-preview-col">
        <Markdown text={value} />
      </div>
    </div>
  )
}

/** 第二步审核字段编辑器：预览 / 编辑 双标签 */
function SectionEditor({
  title,
  value,
  onChange,
  placeholder
}: {
  title: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <Tabs
      size="small"
      items={[
        {
          key: 'preview',
          label: '预览',
          children: <Markdown text={value} />
        },
        {
          key: 'edit',
          label: '编辑',
          children: (
            <Input.TextArea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              autoSize={{ minRows: 4, maxRows: 14 }}
              placeholder={placeholder}
            />
          )
        }
      ]}
    />
  )
}

/** 纠错面板：第一步教师反馈（左图右表单）→ 第二步 AI 分析优化（流式 + 审核确认） */
export default function CorrectionApp() {
  const { message } = AntdApp.useApp()
  const [init, setInit] = useState<CorrectionInitPayload | null>(null)
  const [step, setStep] = useState<Step>('feedback')
  // 教师反馈
  const [teacherScores, setTeacherScores] = useState<number[]>([])
  const [reasoning, setReasoning] = useState('')
  const [totalOverride, setTotalOverride] = useState<number | null>(null)
  const [totalTouched, setTotalTouched] = useState(false)
  // AI 润色 / 分析
  const [polishing, setPolishing] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeText, setAnalyzeText] = useState('')
  const [sections, setSections] = useState<CorrectionAnalysisSections | null>(null)
  // 第二步审核编辑值
  const [editReason, setEditReason] = useState('')
  const [editRef, setEditRef] = useState('')
  const [editRubric, setEditRubric] = useState('')
  const [applying, setApplying] = useState(false)
  const streamRef = useRef<((e: { kind: 'analyze' | 'polish'; delta: string }) => void) | null>(null)

  // 主进程推送初始化数据（preload 有缓存，先到后注册不丢）
  useEffect(() => {
    window.api.onCorrectionInit((data) => {
      setInit(data)
      setStep('feedback')
      setAnalyzeText('')
      setSections(null)
      setApplying(false)
      const subs = data.subQuestions
      const scores = subs.length
        ? subs.map((sq, i) => data.record.subScores[i]?.finalScore ?? sq.maxScore)
        : [data.record.finalScore ?? data.scoreConfig.max]
      setTeacherScores(scores)
      setReasoning(data.record.reasoning ?? '')
      setTotalOverride(null)
      setTotalTouched(false)
    })
  }, [])

  // 流式增量：分析 / 润色
  useEffect(() => {
    const off = window.api.onCorrectionStream((e) => streamRef.current?.(e))
    return off
  }, [])

  const subs = init?.subQuestions ?? []
  const multi = subs.length > 0
  const scoreCfg = init?.scoreConfig ?? { total: 10, min: 0, max: 10, step: 1 }
  const record = init?.record ?? null
  const autoTotal = useMemo(
    () => Number(teacherScores.reduce((s, v) => s + (v || 0), 0).toFixed(2)),
    [teacherScores]
  )
  const scoresValid = teacherScores.length > 0 && teacherScores.every((v) => typeof v === 'number' && Number.isFinite(v))

  /** AI 润色评分理由（流式回填编辑框） */
  const doPolish = async () => {
    if (!record || !reasoning.trim()) return
    setPolishing(true)
    let buf = ''
    streamRef.current = (e) => {
      if (e.kind === 'polish') {
        buf += e.delta
        setReasoning(buf)
      }
    }
    try {
      const r = await window.api.correctionPolish(reasoning, record)
      if (r && typeof r === 'object' && 'ok' in r) {
        if (r.ok && r.text) setReasoning(r.text)
        else if (!r.ok) message.error(r.error ?? '润色失败')
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      streamRef.current = null
      setPolishing(false)
    }
  }

  /** 第一步 → 第二步：启动 AI 差异分析（流式展示） */
  const goAnalyze = async () => {
    if (!record || !scoresValid) return
    setStep('analysis')
    setAnalyzing(true)
    setAnalyzeText('')
    let buf = ''
    streamRef.current = (e) => {
      if (e.kind === 'analyze') {
        buf += e.delta
        setAnalyzeText(buf)
      }
    }
    try {
      const r = await window.api.correctionAnalyze({ record, teacherScores, reasoning })
      if (r && typeof r === 'object' && 'ok' in r) {
        if (r.ok && r.sections) {
          setSections(r.sections)
          setEditReason(r.sections.reason)
          setEditRef(r.sections.newReferenceAnswer)
          setEditRubric(r.sections.newRubric)
          setStep('review')
        } else if (!r.ok) {
          message.error(r.error ?? 'AI 分析失败')
        }
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      streamRef.current = null
      setAnalyzing(false)
    }
  }

  /** 应用纠错并关闭面板（确认提交 / 审核确认后） */
  const applyCorrection = async (standardUpdates?: { referenceAnswer?: string; rubric?: string } | null) => {
    if (!record || !scoresValid) return
    setApplying(true)
    try {
      const r = await window.api.gradingControl('correctionApply', {
        scores: teacherScores,
        reasoning,
        ...(totalTouched && totalOverride !== null ? { totalScoreOverride: totalOverride } : {}),
        ...(standardUpdates ? { standardUpdates } : {})
      })
      if (r && !r.ok) {
        message.error(r.message ?? '应用失败')
        return
      }
      message.success('已确认提交，即将继续批改')
      setTimeout(() => window.api.closeCorrection(), 600)
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  /** 不提交：跳过本题并关闭纠错窗口 */
  const doReject = async () => {
    setApplying(true)
    try {
      const r = await window.api.gradingControl('reject')
      if (r && !r.ok) {
        message.error(r.message ?? '操作失败')
        setApplying(false)
        return
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
      setApplying(false)
      return
    }
    window.api.closeCorrection()
  }

  if (!init || !record) {
    return (
      <div className="app-shell">
        <div className="title-bar">
          <span className="brand">✦ AI 纠错</span>
        </div>
        <div className="panel-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Spin tip="正在加载纠错数据…" />
        </div>
      </div>
    )
  }

  const stepIndex = step === 'feedback' ? 0 : step === 'analysis' ? 1 : 2

  return (
    <div className="app-shell">
      <div className="title-bar">
        <span className="brand">
          ✦ AI 纠错 · 第 {record.seq} 题{init.standardName ? ` · ${init.standardName}` : ''}
        </span>
        <button className="bar-btn" title="关闭（稍后可在侧边栏重新打开）" onClick={() => window.api.closeCorrection()}>
          <CloseOutlined />
        </button>
      </div>

      <div className="panel-body">
        <Steps
          size="small"
          current={stepIndex}
          items={[
            { title: '教师反馈' },
            { title: 'AI 分析', description: analyzing ? '分析中…' : undefined },
            { title: '审核确认' }
          ]}
        />

        {/* ---------- 第一步：教师反馈（左图右表单） ---------- */}
        {step === 'feedback' && (
          <div className="feedback-layout">
            <div className="img-pane">
              <img src={init.captureDataUrl} alt="学生答题卡" />
            </div>
            <div className="form-pane">
              <Card size="small" title="AI 评分" styles={{ body: { padding: '8px 12px' } }}>
                <Descriptions
                  size="small"
                  column={1}
                  items={[
                    { key: 'total', label: 'AI 总分', children: <Text strong style={{ fontSize: 18 }}>{record.finalScore ?? '-'} 分</Text> },
                    ...(record.subScores.length > 1
                      ? [
                          {
                            key: 'subs',
                            label: '各小题',
                            children: (
                              <div className="sub-score-list">
                                {record.subScores.map((s, i) => (
                                  <div key={`${s.subId}-${i}`} className="sub-score-row">
                                    <Text style={{ fontSize: 12 }}>{s.name}</Text>
                                    <Text strong style={{ fontSize: 12 }}>{s.finalScore ?? '-'} 分</Text>
                                  </div>
                                ))}
                              </div>
                            )
                          }
                        ]
                      : [])
                  ]}
                />
                {record.reasoning && (
                  <Collapse
                    size="small"
                    ghost
                    items={[{ key: 'r', label: 'AI 评分理由', children: <Markdown text={record.reasoning} /> }]}
                  />
                )}
              </Card>

              <Card size="small" title="识别答案" styles={{ body: { padding: '8px 12px' } }}>
                {record.ocrText ? (
                  <Paragraph style={{ fontSize: 12, marginBottom: 0 }} ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}>
                    {record.ocrText}
                  </Paragraph>
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    （多模态直评模式，本次无 OCR 转录文本，请对照左侧答题卡图片）
                  </Text>
                )}
              </Card>

              <Card size="small" title="教师反馈" styles={{ body: { padding: '8px 12px' } }}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {multi ? (
                    <>
                      {subs.map((sq, i) => (
                        <div key={sq.id} className="sub-score-row" style={{ gap: 8 }}>
                          <Text style={{ fontSize: 12, flex: 1 }}>{sq.name}</Text>
                          <InputNumber
                            size="small"
                            value={teacherScores[i]}
                            onChange={(v) =>
                              setTeacherScores((prev) => prev.map((s, j) => (j === i ? Number(v) : s)))
                            }
                            min={sq.minScore}
                            max={sq.maxScore}
                            step={sq.step || 1}
                            precision={2}
                            style={{ width: 90 }}
                            addonAfter="分"
                          />
                        </div>
                      ))}
                      <div className="sub-score-row" style={{ gap: 8 }}>
                        <Text style={{ fontSize: 12, flex: 1 }}>
                          总分
                          <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>
                            （自动 = 各小题之和 {autoTotal}，可手动覆盖）
                          </Text>
                        </Text>
                        <InputNumber
                          size="small"
                          value={totalTouched ? totalOverride : autoTotal}
                          onChange={(v) => {
                            setTotalTouched(true)
                            setTotalOverride(v === null ? null : Number(v))
                          }}
                          min={scoreCfg.min}
                          max={scoreCfg.max}
                          step={scoreCfg.step || 1}
                          precision={2}
                          style={{ width: 90 }}
                          addonAfter="分"
                        />
                      </div>
                    </>
                  ) : (
                    <div className="sub-score-row" style={{ gap: 8 }}>
                      <Text style={{ fontSize: 12, flex: 1 }}>正确得分</Text>
                      <InputNumber
                        size="small"
                        value={teacherScores[0]}
                        onChange={(v) => setTeacherScores([Number(v)])}
                        min={scoreCfg.min}
                        max={scoreCfg.max}
                        step={scoreCfg.step || 1}
                        precision={2}
                        style={{ width: 110 }}
                        addonAfter="分"
                      />
                    </div>
                  )}

                  <div>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      评分理由（可选但强烈推荐，支持 Markdown 编辑与实时预览）
                    </Text>
                    <ReasonEditor
                      value={reasoning}
                      onChange={setReasoning}
                      polishing={polishing}
                      onPolish={() => void doPolish()}
                    />
                  </div>

                  <Space wrap>
                    <Button
                      type="primary"
                      icon={<CheckOutlined />}
                      disabled={!scoresValid}
                      loading={applying}
                      onClick={() => void applyCorrection(null)}
                    >
                      确认提交
                    </Button>
                    <Button icon={<ExperimentOutlined />} disabled={!scoresValid} onClick={() => void goAnalyze()}>
                      下一步分析
                    </Button>
                    <Button danger icon={<CloseOutlined />} loading={applying} onClick={() => void doReject()}>
                      不提交（跳过）
                    </Button>
                  </Space>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    确认提交：按当前分数直接提交（可先修改分数与理由），不触发 AI
                    分析、不修改评分标准（适合个别特殊答案）；下一步分析：AI 分析差异并优化参考答案与评分标准
                  </Text>
                </Space>
              </Card>
            </div>
          </div>
        )}

        {/* ---------- 第二步：AI 分析优化（流式展示） ---------- */}
        {step === 'analysis' && (
          <Card
            size="small"
            title="AI 分析优化"
            extra={
              <Space>
                {analyzing && <Spin size="small" />}
                <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => setStep('feedback')}>
                  返回修改
                </Button>
              </Space>
            }
            styles={{ body: { padding: '8px 16px' } }}
          >
            {analyzeText ? (
              <div className="analysis-stream">
                <Markdown text={analyzeText} />
                {analyzing && <span className="stream-cursor" />}
              </div>
            ) : (
              <div className="analysis-waiting">
                <Spin />
                <Text type="secondary" style={{ marginTop: 8 }}>
                  正在对比 AI 评分与教师评分差异，分析原因并生成优化建议…
                </Text>
              </div>
            )}
          </Card>
        )}

        {/* ---------- 第二步完成：审核 AI 建议 ---------- */}
        {step === 'review' && sections && (
          <div className="review-layout">
            <Card
              size="small"
              title="修改理由 — AI 对差异原因的分析"
              extra={<Tag color="blue">可编辑</Tag>}
              styles={{ body: { padding: '4px 12px 8px' } }}
            >
              <SectionEditor title="修改理由" value={editReason} onChange={setEditReason} />
            </Card>
            <Card
              size="small"
              title="新参考答案"
              extra={editRef ? <Tag color="green">有修改</Tag> : <Tag>无需修改</Tag>}
              styles={{ body: { padding: '4px 12px 8px' } }}
            >
              {editRef ? (
                <SectionEditor title="新参考答案" value={editRef} onChange={setEditRef} />
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  AI 认为当前参考答案无需修改
                </Text>
              )}
            </Card>
            <Card
              size="small"
              title="新评分标准"
              extra={editRubric ? <Tag color="green">有修改</Tag> : <Tag>无需修改</Tag>}
              styles={{ body: { padding: '4px 12px 8px' } }}
            >
              {editRubric ? (
                <SectionEditor title="新评分标准" value={editRubric} onChange={setEditRubric} />
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  AI 认为当前评分标准无需修改
                </Text>
              )}
            </Card>
            <Space wrap style={{ marginTop: 4 }}>
              <Button
                type="primary"
                icon={<SafetyOutlined />}
                loading={applying}
                onClick={() =>
                  void applyCorrection({
                    ...(editRef.trim() ? { referenceAnswer: editRef.trim() } : {}),
                    ...(editRubric.trim() ? { rubric: editRubric.trim() } : {})
                  })
                }
              >
                确认更新并提交
              </Button>
              <Button icon={<CheckOutlined />} loading={applying} onClick={() => void applyCorrection(null)}>
                仅提交分数（不更新标准）
              </Button>
              <Button icon={<ArrowLeftOutlined />} onClick={() => setStep('feedback')}>
                返回修改
              </Button>
              <Text type="secondary" style={{ fontSize: 11 }}>
                确认更新后将自动写入当前评分标准的参考答案与评分细则，后续批改即生效
              </Text>
            </Space>
          </div>
        )}
      </div>
    </div>
  )
}
