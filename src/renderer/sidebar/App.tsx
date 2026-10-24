import { useEffect, useRef, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Input,
  InputNumber,
  Row,
  Segmented,
  Space,
  Statistic,
  Tag,
  Typography
} from 'antd'
import {
  ApartmentOutlined,
  CheckOutlined,
  CloudServerOutlined,
  DownloadOutlined,
  FileTextOutlined,
  HomeOutlined,
  LeftOutlined,
  MinusOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RightOutlined,
  SelectOutlined,
  SettingOutlined,
  StopOutlined,
  UploadOutlined
} from '@ant-design/icons'
import type { GradingState, WorkflowConfig } from '@shared/types'
import { useConfigStore } from '@renderer/stores/config'
import { useGradingStore } from '@renderer/stores/grading'
import { SETTINGS_PAGES, normalizeSettingsPage, settingsPageByKey } from '@renderer/settings/pages'
import { GRADING_MODE_DESC } from '@renderer/settings/pages/Workflow'
import Hint from '@renderer/settings/Hint'

const { Text, Title, Paragraph } = Typography

const STATE_INFO: Record<GradingState, { label: string; color: string }> = {
  idle: { label: '空闲', color: 'default' },
  ready: { label: '就绪', color: 'processing' },
  capturing: { label: '截取题目', color: 'processing' },
  recognizing: { label: '识别作答内容', color: 'processing' },
  scoring: { label: 'AI 评分中', color: 'processing' },
  scoring2: { label: '第二模型评分中', color: 'processing' },
  arbitrating: { label: '等待人工仲裁', color: 'warning' },
  awaiting_submit: { label: '等待提交', color: 'success' },
  submitting: { label: '填分提交中', color: 'processing' },
  waiting_next: { label: '等待下一题', color: 'cyan' },
  paused_sameQuestion: { label: '疑似未翻页', color: 'error' },
  paused_notAdvanced: { label: '未翻页暂停', color: 'error' },
  paused_provider: { label: '服务异常暂停', color: 'error' },
  paused_parseFailed: { label: '待人工给分', color: 'error' },
  paused_manual: { label: '手动暂停', color: 'warning' },
  paused_error: { label: '异常暂停', color: 'error' }
}

/** 悬浮侧边栏：批改控制台（状态/倒计时/四模式/仲裁/人工兜底/统计/设置入口）+ 集成设置视图 */
export default function SidebarApp() {
  const { config, load, patch } = useConfigStore()
  const g = useGradingStore()
  const { message } = AntdApp.useApp()
  const [manualScore, setManualScore] = useState('')
  const [arbScore, setArbScore] = useState<number | null>(null)
  // 仲裁偏向统计：人工仲裁分更接近哪个模型就给哪方 +1；某方领先 ≥2 次后，建议值改为该模型分数
  const arbBiasRef = useRef<{ A: number; B: number }>({ A: 0, B: 0 })
  // 设置视图：showSettings=是否在设置视图；page=null 为设置菜单，否则为具体设置页 key
  const [showSettings, setShowSettings] = useState(false)
  const [page, setPage] = useState<string | null>(null)

  const openSettingsMenu = () => {
    setShowSettings(true)
    setPage(null)
  }
  const openSettingsPage = (p: string) => {
    setShowSettings(true)
    setPage(normalizeSettingsPage(p))
  }
  const exitSettings = () => {
    setShowSettings(false)
    setPage(null)
  }

  useEffect(() => {
    void load()
    useGradingStore.getState().init()
  }, [load])

  // 主进程 openSettings() → 唤起侧边栏并导航到对应设置页（空串=设置菜单；旧键自动映射到合并页分区）
  useEffect(() => {
    const off = window.api.onNavigate((p) => {
      setShowSettings(true)
      setPage(p ? normalizeSettingsPage(p) : null)
    })
    return off
  }, [])

  // 仲裁事件到达：历史仲裁明显偏向某模型（领先 ≥2 次）时，建议值取该模型分数；否则取双评均值
  useEffect(() => {
    const rec = g.arbitrate?.record
    if (rec && typeof rec.scoreA === 'number' && typeof rec.scoreB === 'number') {
      const bias = arbBiasRef.current
      const lead = bias.A >= bias.B + 2 ? 'A' : bias.B >= bias.A + 2 ? 'B' : null
      const suggest = lead === 'A' ? rec.scoreA : lead === 'B' ? rec.scoreB : (rec.scoreA + rec.scoreB) / 2
      setArbScore(Number(suggest.toFixed(2)))
    } else {
      setArbScore(null)
    }
  }, [g.arbitrate])

  /** 应用仲裁分：同时记录本次仲裁更偏向哪个模型，供后续建议值参考 */
  const applyArbiter = () => {
    const rec = g.arbitrate?.record
    if (typeof arbScore === 'number' && rec && typeof rec.scoreA === 'number' && typeof rec.scoreB === 'number') {
      const dA = Math.abs(arbScore - rec.scoreA)
      const dB = Math.abs(arbScore - rec.scoreB)
      if (dA < dB) arbBiasRef.current.A += 1
      else if (dB < dA) arbBiasRef.current.B += 1
    }
    void g.control('arbiterApply', arbScore)
  }

  const running = g.state !== 'idle'
  const paused = g.state.startsWith('paused')
  const wf = config?.workflow
  const gradingMode = wf?.gradingMode ?? 'trial'
  const saveWf = (p: Partial<WorkflowConfig>) => {
    if (!wf) return
    void patch({ workflow: { ...wf, ...p } } as never).catch((err: unknown) =>
      message.error(err instanceof Error ? err.message : String(err))
    )
  }
  const scoreCfg = config?.scoreConfig ?? { total: 10, min: 0, max: 10, step: 1 }
  const enabledSubs = config?.subQuestions.filter((s) => s.enabled) ?? []

  /** 人工给分输入解析：分小题时按顺序逗号分隔多个分数，整题时单个数字 */
  const parseManualScores = (): number[] | null => {
    const parts = manualScore.split(/[,，\s]+/).filter(Boolean).map(Number)
    if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null
    if (enabledSubs.length > 0) return parts.length === enabledSubs.length ? parts : null
    return parts.length === 1 ? parts : null
  }
  const submitManualScore = () => {
    const parts = parseManualScores()
    if (!parts) return
    void g.control('manualScore', parts)
    setManualScore('')
  }
  const doStart = async () => {
    const r = await g.control('start')
    if (!r.ok && r.message) void message.warning(r.message)
  }

  const info = STATE_INFO[g.state] ?? STATE_INFO.idle

  return (
    <div className="app-shell">
      <div className="title-bar">
        <span className="brand">✦ AI 自动阅卷助手</span>
        {showSettings && (
          <button className="bar-btn" title="返回批改控制台" onClick={exitSettings}>
            <HomeOutlined />
          </button>
        )}
        <button
          className="bar-btn"
          title={showSettings ? '设置菜单' : '打开设置'}
          onClick={openSettingsMenu}
        >
          <SettingOutlined />
        </button>
        <button
          className="bar-btn"
          title="隐藏侧边栏（快捷键呼出）"
          onClick={() => window.api.toggleSidebar()}
        >
          <MinusOutlined />
        </button>
      </div>

      {showSettings ? (
        <SettingsView page={page} onBack={() => setPage(null)} onExit={exitSettings} onNavigate={openSettingsPage} />
      ) : (
      <div className="panel-body">
        {/* 状态卡片 */}
        <Card size="small" styles={{ body: { padding: '10px 12px' } }}>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space>
              <Tag color={info.color}>{info.label}</Tag>
              {config && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  模式：{gradingMode === 'trial' ? '试改' : gradingMode === 'unattended' ? '无人值守' : '双评'}
                  · {wf?.mode === 'A' ? '多模态直评' : wf?.mode === 'B' ? '本机OCR二次评分' : '云端OCR二次评分'}
                </Text>
              )}
            </Space>
            {g.message && <Text style={{ fontSize: 12 }}>{g.message}</Text>}

            {/* 倒计时（无人值守/双评按自定义时长，0 = 直接提交） */}
            {g.state === 'awaiting_submit' && g.countdown > 0 && (
              <>
                <div className="countdown-big">{g.countdown}</div>
                <div className="countdown-sub">秒后自动提交，点击「立即提交」可跳过等待</div>
              </>
            )}
          </Space>
        </Card>

        {/* 前期设置入口：直达各设置分区 */}
        <Card size="small" title="前期设置" styles={{ body: { padding: '8px 10px' } }}>
          <div className="setup-links">
            <Button icon={<CloudServerOutlined />} onClick={() => openSettingsPage('models:providers')}>
              AI 服务商
            </Button>
            <Button icon={<ApartmentOutlined />} onClick={() => openSettingsPage('models:workflow')}>
              模型与规则
            </Button>
            <Button icon={<FileTextOutlined />} onClick={() => openSettingsPage('marking:standards')}>
              评分标准
            </Button>
            <Button icon={<SelectOutlined />} onClick={() => openSettingsPage('marking:regions')}>
              答题区域
            </Button>
          </div>
        </Card>

        {/* 批改模式（高频切换） */}
        {wf && (
          <Card
            size="small"
            title={
              <Space size={6}>
                批改模式
                {running && (
                  <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>
                    批改中修改于下一题生效
                  </Text>
                )}
              </Space>
            }
            styles={{ body: { padding: '8px 12px' } }}
          >
            <div>
              <Segmented
                block
                value={wf.gradingMode}
                onChange={(v) => saveWf({ gradingMode: v as WorkflowConfig['gradingMode'] })}
                options={[
                  { label: '试改', value: 'trial' },
                  { label: '无人', value: 'unattended' },
                  { label: '双评', value: 'double' }
                ]}
              />
              <div style={{ marginTop: 4 }}>
                <Hint text={GRADING_MODE_DESC[wf.gradingMode]} />
              </div>
              {wf.gradingMode === 'unattended' && (
                <Space size={6} style={{ marginTop: 6 }}>
                  <Text style={{ fontSize: 12 }}>提交倒计时</Text>
                  <InputNumber
                    size="small"
                    value={wf.unattendedDelaySec}
                    onChange={(v) => saveWf({ unattendedDelaySec: Math.max(0, Number(v) || 0) })}
                    min={0}
                    max={60}
                    step={1}
                    addonAfter="秒"
                    style={{ width: 55 }}
                  />
                </Space>
              )}
              {wf.gradingMode === 'double' && (
                <Space size={6} style={{ marginTop: 6 }} wrap>
                  <Text style={{ fontSize: 12 }}>分差阈值</Text>
                  <InputNumber
                    size="small"
                    value={wf.doubleThreshold}
                    onChange={(v) => saveWf({ doubleThreshold: Number(v) || 0 })}
                    min={0}
                    max={100}
                    step={0.5}
                    addonAfter="分"
                    style={{ width: 55 }}
                  />
                  <Text style={{ fontSize: 12 }}>提交倒计时</Text>
                  <InputNumber
                    size="small"
                    value={wf.doubleDelaySec}
                    onChange={(v) => saveWf({ doubleDelaySec: Math.max(0, Number(v) || 0) })}
                    min={0}
                    max={60}
                    step={1}
                    addonAfter="秒"
                    style={{ width: 55 }}
                  />
                </Space>
              )}
            </div>
          </Card>
        )}

        {/* 控制按钮 */}
        <Space wrap>
          {!running && wf && (
            <InputNumber
              value={wf.plannedCount || undefined}
              onChange={(v) => saveWf({ plannedCount: Number(v) || 0 })}
              min={1}
              max={9999}
              step={1}
              addonAfter="份"
              placeholder="不限"
              style={{ width: 66 }}
            />
          )}
          {!running && (
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={doStart}>
              批改
            </Button>
          )}
          {running && !paused && (
            <Button icon={<PauseCircleOutlined />} onClick={() => void g.control('pause')}>
              暂停
            </Button>
          )}
          {running && paused && (
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => void g.control('resume')}>
              继续
            </Button>
          )}
          {running && (
            <>
              <Button danger icon={<StopOutlined />} onClick={() => void g.control('stop')}>
                停止
              </Button>
              {(g.state === 'awaiting_submit' || g.state === 'arbitrating' || paused) && (
                <Button icon={<CheckOutlined />} onClick={() => void g.control('skip')}>
                  跳过此题
                </Button>
              )}
            </>
          )}
        </Space>

        {/* 等待提交（试改=人工确认；无人值守/双评=可立即提交） */}
        {g.state === 'awaiting_submit' && (
          <Card size="small" title="提交确认" styles={{ body: { padding: '8px 12px' } }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {gradingMode === 'trial' && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  试改模式：请核对得分后确认提交
                </Text>
              )}
              <Space>
                <Button type="primary" icon={<CheckOutlined />} onClick={() => void g.control('confirm')}>
                  {gradingMode === 'trial' ? '确认提交' : '立即提交'}
                </Button>
                <Button onClick={() => void g.control('reject')}>不提交（跳过）</Button>
              </Space>
            </Space>
          </Card>
        )}

        {/* 双评仲裁 */}
        {g.arbitrate && g.state === 'arbitrating' && (
          <Card
            size="small"
            title={<span style={{ color: '#d46b08' }}>双评分差超阈值，请人工仲裁</span>}
            styles={{ body: { padding: '8px 12px' } }}
          >
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Space wrap>
                <Tag color="blue">模型A：{g.arbitrate.record.scoreA ?? '-'}</Tag>
                <Tag color="purple">模型B：{g.arbitrate.record.scoreB ?? '-'}</Tag>
                <Tag>阈值：±{g.arbitrate.threshold}</Tag>
              </Space>
              {(() => {
                const bias = arbBiasRef.current
                const lead = bias.A >= bias.B + 2 ? 'A' : bias.B >= bias.A + 2 ? 'B' : null
                if (!lead) return null
                const fav = lead === 'A' ? g.arbitrate.record.scoreA : g.arbitrate.record.scoreB
                return (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    历史仲裁更接近模型{lead}（{bias.A}:{bias.B}），建议值已改为模型{lead}分数 {fav}
                  </Text>
                )
              })()}
              <Space>
                <InputNumber
                  value={arbScore}
                  onChange={(v) => setArbScore(v)}
                  min={scoreCfg.min}
                  max={scoreCfg.max}
                  step={scoreCfg.step}
                  style={{ width: 110 }}
                  addonAfter="分"
                />
                <Button type="primary" disabled={arbScore === null} onClick={applyArbiter}>
                  应用仲裁分
                </Button>
              </Space>
            </Space>
          </Card>
        )}

        {/* 解析失败人工给分 */}
        {g.state === 'paused_parseFailed' && (
          <Card size="small" title="AI 输出无法解析，请人工给分" styles={{ body: { padding: '8px 12px' } }}>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {enabledSubs.length > 1 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  共 {enabledSubs.length} 个小题（{enabledSubs.map((s) => s.name).join('、')}），按顺序输入，逗号分隔
                </Text>
              )}
              <Space>
                <Input
                  value={manualScore}
                  onChange={(e) => setManualScore(e.target.value)}
                  style={{ width: 140 }}
                  placeholder={
                    enabledSubs.length > 1
                      ? `如 ${enabledSubs.map(() => '0').join(',')}`
                      : `${scoreCfg.min}~${scoreCfg.max}`
                  }
                  onPressEnter={() => submitManualScore()}
                />
                <Button type="primary" disabled={!parseManualScores()} onClick={submitManualScore}>
                  提交人工分
                </Button>
                <Button onClick={() => void g.control('reject')}>跳过</Button>
              </Space>
            </Space>
          </Card>
        )}

        {/* 暂停类提示 */}
        {paused && g.state !== 'paused_parseFailed' && (
          <Card size="small" styles={{ body: { padding: '8px 12px' } }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Text style={{ fontSize: 12 }}>{g.message || '已暂停，处理完成后点击「继续」恢复批改'}</Text>
              <Button type="primary" onClick={() => void g.control('resume')}>
                继续
              </Button>
            </Space>
          </Card>
        )}

        {/* 最近一题 */}
        {g.lastRecord && (
          <Card
            size="small"
            title={`第 ${g.lastRecord.seq} 题 · 得分 ${g.lastRecord.finalScore ?? '-'} 分`}
            extra={
              g.lastRecord.submitStatus === 'auto' || g.lastRecord.submitStatus === 'manual' ? (
                <Tag color="success">已提交</Tag>
              ) : g.lastRecord.submitStatus === 'skipped' ? (
                <Tag>已跳过</Tag>
              ) : g.lastRecord.submitStatus === 'failed' ? (
                <Tag color="error">失败</Tag>
              ) : (
                <Tag color="processing">进行中</Tag>
              )
            }
            styles={{ body: { padding: '8px 12px' } }}
          >
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {g.lastRecord.previewDataUrl && (
                <img
                  className="record-preview"
                  src={g.lastRecord.previewDataUrl}
                  alt="题目截图"
                />
              )}
              {g.lastRecord.subScores.length > 0 && (
                <div>
                  {g.lastRecord.subScores.map((s, i) => (
                    <div key={`${s.subId}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <Text>{s.name}</Text>
                      <Text>
                        {typeof s.finalScore === 'number' ? `${s.finalScore} 分` : '未给分'}
                        {s.arbited && <Tag color="orange" style={{ marginLeft: 4 }}>仲裁</Tag>}
                      </Text>
                    </div>
                  ))}
                </div>
              )}
              {g.lastRecord.usedModels.length > 0 && (
                <div>
                  {g.lastRecord.usedModels.map((m, i) => (
                    <Tag key={i} style={{ fontSize: 11 }}>
                      {m}
                    </Tag>
                  ))}
                </div>
              )}
              {g.lastRecord.ocrText && (
                <Paragraph
                  style={{ fontSize: 12, marginBottom: 0 }}
                  ellipsis={{ rows: 3, expandable: true, symbol: '展开识别文本' }}
                >
                  {g.lastRecord.ocrText}
                </Paragraph>
              )}
            </Space>
          </Card>
        )}

        {/* 统计 */}
        {g.stats && (
          <Card size="small" styles={{ body: { padding: '8px 12px' } }}>
            <Row gutter={8}>
              <Col span={8}>
                <Statistic title="已批" value={g.stats.total} valueStyle={{ fontSize: 18 }} />
              </Col>
              <Col span={8}>
                <Statistic title="提交" value={g.stats.submitted} valueStyle={{ fontSize: 18 }} />
              </Col>
              <Col span={8}>
                <Statistic title="仲裁" value={g.stats.arbitrated} valueStyle={{ fontSize: 18 }} />
              </Col>
              <Col span={8}>
                <Statistic title="平均分" value={g.stats.avgScore} precision={2} valueStyle={{ fontSize: 18 }} />
              </Col>
              <Col span={8}>
                <Statistic title="最低" value={g.stats.minScore} precision={2} valueStyle={{ fontSize: 18 }} />
              </Col>
              <Col span={8}>
                <Statistic title="最高" value={g.stats.maxScore} precision={2} valueStyle={{ fontSize: 18 }} />
              </Col>
            </Row>
          </Card>
        )}

        <Divider style={{ margin: '4px 0' }} />
        <Text type="secondary" style={{ fontSize: 11, textAlign: 'center', display: 'block' }}>
          快捷键 {config?.settings.hotkeyToggle ?? '-'} 呼出/隐藏 · 拖动顶栏移动位置
          {g.autoImpl && (
            <>
              {' '}
              · 键鼠：{g.autoImpl.impl === 'nut' ? '原生驱动' : '系统脚本'}
              {!g.autoImpl.ok && <Tag color="error">不可用</Tag>}
            </>
          )}
        </Text>
        <Title level={5} style={{ display: 'none' }}>
          AI 自动阅卷
        </Title>
      </div>
      )}
    </div>
  )
}

/** 设置视图：设置菜单列表 + 各设置详情页（集成在侧边栏内，复用 settings/pages 组件库） */
function SettingsView({
  page,
  onBack,
  onExit,
  onNavigate
}: {
  page: string | null
  onBack: () => void
  onExit: () => void
  onNavigate: (p: string) => void
}) {
  const { config, load } = useConfigStore()
  const { message } = AntdApp.useApp()
  const def = page ? settingsPageByKey(page) : undefined

  const doImport = async () => {
    const r = await window.api.importConfig()
    if (r) {
      await load()
      void message.success('配置导入成功')
    }
  }
  const doExport = async () => {
    const r = await window.api.exportConfig()
    if (r) void message.success(`配置已导出至：${r}`)
  }

  return (
    <>
      <div className="settings-nav">
        <Button type="text" size="small" icon={<LeftOutlined />} onClick={page ? onBack : onExit}>
          {page ? '设置' : '控制台'}
        </Button>
        <Text strong ellipsis style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: 13 }}>
          {page && def ? def.label : '设置'}
        </Text>
        <span style={{ width: 52, flex: 'none' }} />
      </div>

      <div className="settings-body">
        {!page ? (
          <>
            <div className="settings-menu">
              {SETTINGS_PAGES.map((p) => (
                <button key={p.key} className="settings-menu-item" onClick={() => onNavigate(p.key)}>
                  <span className="mi-icon">{p.icon}</span>
                  <span className="mi-text">
                    <span className="mi-label">{p.label}</span>
                    <span className="mi-desc">{p.desc}</span>
                  </span>
                  <RightOutlined className="mi-arrow" />
                </button>
              ))}
            </div>
            <div className="settings-io">
              <Button size="small" block icon={<DownloadOutlined />} onClick={() => void doExport()}>
                导出配置
              </Button>
              <Button size="small" block icon={<UploadOutlined />} onClick={() => void doImport()}>
                导入配置
              </Button>
            </div>
          </>
        ) : def ? (
          config ? (
            def.render(onNavigate, page ?? '')
          ) : (
            <Empty description="配置加载中…" style={{ marginTop: 60 }} />
          )
        ) : null}
      </div>
    </>
  )
}
