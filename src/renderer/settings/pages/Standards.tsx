import { useEffect, useRef, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography
} from 'antd'
import {
  AimOutlined,
  ClearOutlined,
  DeleteOutlined,
  ExportOutlined,
  PictureOutlined,
  StarOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { ScoringStandard } from '@shared/types'
import { isStandardUsable } from '@shared/types'
import { Markdown } from '@renderer/components/Markdown'
import { useConfigStore } from '@renderer/stores/config'
import { genId, unwrap, useNarrow } from '@renderer/utils'
import Hint from '@renderer/settings/Hint'

const { Text, Title, Paragraph } = Typography

function emptyStd(): ScoringStandard {
  return {
    id: genId('std'),
    name: '',
    subject: '',
    grade: '',
    questionType: '',
    rubric: '',
    questionStem: '',
    referenceAnswer: '',
    answerRequirement: '',
    sampleAnswer: '',
    sampleImages: [],
    enabled: false
  }
}

/** 评分标准管理：4+1 子页、Markdown/LaTeX 实时渲染、窗口内粘贴截图自动识别、AI 自动生成细则、10 套预设循环切换 */
export default function StandardsPage() {
  const { config, patch } = useConfigStore()
  const { message } = AntdApp.useApp()
  const narrow = useNarrow()
  const [idx, setIdx] = useState(0)
  const [draft, setDraft] = useState<ScoringStandard>(emptyStd())
  const [aiOpen, setAiOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [imgBusy, setImgBusy] = useState(false)
  const [activeTab, setActiveTab] = useState('rubric')
  const [pasteBusy, setPasteBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 最近聚焦的编辑框（按子页 key），窗口粘贴时优先插入其光标处 */
  const lastTa = useRef<{ key: string; el: HTMLTextAreaElement } | null>(null)
  /** 页面根节点：用于判断当前是否处于可见分区 */
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!config) return
    const s = config.scoringStandards[idx]
    setDraft(s ? { ...s } : emptyStd())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx])

  if (!config) return null

  const usable = isStandardUsable(draft)
  const isActive = idx === config.activeStandardIndex

  const update = (p: Partial<ScoringStandard>) => {
    const next = { ...draft, ...p }
    setDraft(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const arr = config.scoringStandards.slice()
      arr[idx] = next
      void patch({ scoringStandards: arr }).catch((err: unknown) =>
        message.error(err instanceof Error ? err.message : String(err))
      )
    }, 350)
  }

  const clearSlot = async () => {
    const arr = config.scoringStandards.slice()
    arr[idx] = null
    await patch({ scoringStandards: arr })
    setDraft(emptyStd())
    void message.success('已清空该套标准')
  }

  const addImages = async () => {
    setImgBusy(true)
    try {
      const paths = unwrap<string[]>(await window.api.addStandardImage(draft.id))
      if (paths.length) {
        update({ sampleImages: [...draft.sampleImages, ...paths] })
        void message.success(`已导入 ${paths.length} 张参考图片`)
      }
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setImgBusy(false)
    }
  }

  // ---- 窗口内任意位置 Ctrl+V 粘贴截图 → 自动识别并嵌入当前子页编辑框 ----
  const FIELD_OF_TAB: Record<string, keyof ScoringStandard> = {
    rubric: 'rubric',
    stem: 'questionStem',
    answer: 'referenceAnswer',
    requirement: 'answerRequirement',
    sample: 'sampleAnswer'
  }

  const handlePasteImage = async (dataUrl: string): Promise<void> => {
    if (pasteBusy) return
    setPasteBusy(true)
    void message.open({ key: 'stdPaste', type: 'loading', content: '正在识别粘贴的截图…', duration: 0 })
    try {
      // 原图保存到本地并嵌入 Markdown（保留几何图形等无法转录的内容）
      const rel = unwrap<string>(await window.api.saveStandardImage(dataUrl))
      let md = ''
      let ocrError = ''
      try {
        md = unwrap<string>(await window.api.imageToMarkdown(dataUrl))
      } catch (err) {
        // 识别调用失败（模型未配置/不可达/不支持图片）：保留原图嵌入，但必须把原因告知用户，不能伪装成"未识别到文字"
        ocrError = err instanceof Error ? err.message : String(err)
      }
      const parts: string[] = []
      if (md.trim()) parts.push(md.trim())
      parts.push(`![粘贴截图](stdimg://local/${rel})`)
      const field = FIELD_OF_TAB[activeTab] ?? 'rubric'
      const cur = String(draft[field] ?? '')
      const focused = lastTa.current?.key === activeTab ? lastTa.current.el : null
      const pos = focused?.selectionStart ?? cur.length
      const prefix = cur.slice(0, pos)
      const suffix = cur.slice(pos)
      const lead = prefix && !prefix.endsWith('\n') ? '\n\n' : ''
      const tail = suffix && !suffix.startsWith('\n') ? '\n\n' : ''
      update({ [field]: `${prefix}${lead}${parts.join('\n\n')}${tail}${suffix}` } as Partial<ScoringStandard>)
      void message.open({
        key: 'stdPaste',
        type: md.trim() ? 'success' : ocrError ? 'warning' : 'success',
        content: md.trim()
          ? '截图已识别为 Markdown 并嵌入原图'
          : ocrError
            ? `截图已嵌入原图；文字识别失败：${ocrError}`
            : '截图已嵌入（未识别到文字，图形已保留）',
        duration: ocrError ? 6 : 2
      })
    } catch (err) {
      void message.open({
        key: 'stdPaste',
        type: 'error',
        content: err instanceof Error ? err.message : String(err),
        duration: 3
      })
    } finally {
      setPasteBusy(false)
    }
  }

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      // 页面处于隐藏分区（display:none）时不响应，避免在其他设置页粘贴被误插入
      if (rootRef.current?.offsetParent == null) return
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => void handlePasteImage(String(reader.result))
      reader.readAsDataURL(file)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  const onTaFocus = (key: string, el: HTMLTextAreaElement): void => {
    lastTa.current = { key, el }
  }

  const slotOptions = config.scoringStandards.map((s, i) => ({
    label: `第 ${i + 1} 套：${s?.name?.trim() || '（空）'}${i === config.activeStandardIndex ? ' ✓启用' : ''}`,
    value: i
  }))

  // 下拉选择某套即切换编辑并直接启用该套
  const selectSlot = (i: number) => {
    setIdx(i)
    if (i !== config.activeStandardIndex) void patch({ activeStandardIndex: i })
  }

  return (
    <div ref={rootRef}>
      <Title level={4} className="page-title">
        评分标准管理
      </Title>
      <Paragraph className="page-desc">
        评分标准 / 题目题干 / 参考答案 / 作答要求 / 示例参考五个子页，任意子页有内容即可批改；最多 10 套循环切换。
      </Paragraph>

      <Hint text="支持 Markdown 与 LaTeX 渲染；窗口内任意位置直接 Ctrl+V 粘贴截图即自动识别：文字转 Markdown，图形嵌入原图；AI 自动生成细则；批改时可在侧边栏用 ‹ › 循环切换启用套。" />

      {/* 套选择 + 元信息 */}
      <Card styles={{ body: { padding: 16 } }}>
        <Row gutter={[12, 10]} align="middle" style={{ marginBottom: 12 }}>
          <Col span={narrow ? 24 : undefined} flex={narrow ? undefined : 'auto'}>
            <Select value={idx} onChange={selectSlot} options={slotOptions} style={{ width: narrow ? '100%' : 300 }} />
          </Col>
          <Col span={narrow ? 24 : undefined} flex={narrow ? undefined : 'auto'}>
            {narrow ? (
              <Space wrap>
                {isActive && (
                  <Tag color="green" icon={<StarOutlined />}>
                    当前启用（第 {idx + 1} 套）
                  </Tag>
                )}
                <Button size="small" icon={<ThunderboltOutlined />} onClick={() => setAiOpen(true)}>
                  AI 自动生成评分细则
                </Button>
                <Popconfirm title="清空该套标准的全部内容？" onConfirm={() => void clearSlot()}>
                  <Button size="small" danger icon={<ClearOutlined />}>
                    清空此套
                  </Button>
                </Popconfirm>
                <Tag color={usable ? 'success' : 'error'}>{usable ? '内容可用，可启动批改' : '内容为空：填写任意子页即可批改'}</Tag>
              </Space>
            ) : (
              <>
                {isActive && (
                  <Tag color="green" icon={<StarOutlined />} style={{ marginLeft: 8 }}>
                    当前启用（第 {idx + 1} 套）
                  </Tag>
                )}
                <Button size="small" icon={<ThunderboltOutlined />} onClick={() => setAiOpen(true)}>
                  AI 自动生成评分细则
                </Button>
                <Popconfirm title="清空该套标准的全部内容？" onConfirm={() => void clearSlot()}>
                  <Button size="small" danger icon={<ClearOutlined />}>
                    清空此套
                  </Button>
                </Popconfirm>
                <Tag color={usable ? 'success' : 'error'}>{usable ? '内容可用，可启动批改' : '内容为空：填写任意子页即可批改'}</Tag>
              </>
            )}
          </Col>
        </Row>

        <Row gutter={[12, 10]}>
          <Col span={narrow ? 12 : undefined} flex={narrow ? undefined : 'auto'}>
            <Text type="secondary" style={{ fontSize: 12 }}>名称</Text>
            <Input
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="例：2024 期中·数学·解三角形大题"
            />
          </Col>
          <Col span={narrow ? 12 : undefined} flex={narrow ? undefined : 'auto'}>
            <Text type="secondary" style={{ fontSize: 12 }}>年段</Text>
            <Input value={draft.grade} onChange={(e) => update({ grade: e.target.value })} placeholder="例：高三" />
          </Col>
          <Col span={narrow ? 12 : undefined} flex={narrow ? undefined : 'auto'}>
            <Text type="secondary" style={{ fontSize: 12 }}>学科</Text>
            <Input value={draft.subject} onChange={(e) => update({ subject: e.target.value })} placeholder="例：数学" />
          </Col>
          <Col span={narrow ? 12 : undefined} flex={narrow ? undefined : 'auto'}>
            <Text type="secondary" style={{ fontSize: 12 }}>题型</Text>
            <Input value={draft.questionType} onChange={(e) => update({ questionType: e.target.value })} placeholder="例：解答题" />
          </Col>
        </Row>
      </Card>

      {/* 4+1 子页 */}
      <Card style={{ marginTop: 16 }} styles={{ body: { paddingTop: 8 } }}>
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k)}
          items={[
            {
              key: 'rubric',
              label: '评分标准',
              children: <EditPane tabKey="rubric" onTaFocus={onTaFocus} value={draft.rubric} rows={14} onChange={(v) => update({ rubric: v })} placeholder="按得分点 / 分档列出细则，可使用 Markdown 列表与 LaTeX 公式…" />
            },
            {
              key: 'stem',
              label: '题目题干',
              children: <EditPane tabKey="stem" onTaFocus={onTaFocus} value={draft.questionStem} rows={14} onChange={(v) => update({ questionStem: v })} placeholder="粘贴题目原文；公式用 $...$ 包裹" />
            },
            {
              key: 'answer',
              label: '参考答案',
              children: <EditPane tabKey="answer" onTaFocus={onTaFocus} value={draft.referenceAnswer} rows={14} onChange={(v) => update({ referenceAnswer: v })} placeholder="参考答案与每一步给分要点…" />
            },
            {
              key: 'requirement',
              label: '作答要求',
              children: <EditPane tabKey="requirement" onTaFocus={onTaFocus} value={draft.answerRequirement} rows={14} onChange={(v) => update({ answerRequirement: v })} placeholder="例如：需写出完整过程；结果错误但过程正确可给步骤分…" />
            },
            {
              key: 'sample',
              label: '示例参考',
              children: (
                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                  <EditPane tabKey="sample" onTaFocus={onTaFocus} value={draft.sampleAnswer} rows={8} onChange={(v) => update({ sampleAnswer: v })} placeholder="评分参考的文字说明（可留空，仅导入图片亦可批改）" />
                  <Space wrap>
                    <Button icon={<PictureOutlined />} loading={imgBusy} onClick={() => void addImages()}>
                      导入参考图片 / 屏幕截图
                    </Button>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      图片将随评分请求作为参考发送（最多 3 张）
                    </Text>
                  </Space>
                  {draft.sampleImages.length > 0 && (
                    <Space wrap size={10}>
                      {draft.sampleImages.map((rel) => (
                        <div key={rel} className="std-img-thumb">
                          <StandardImage rel={rel} />
                          <button
                            className="del"
                            title="删除"
                            onClick={() => update({ sampleImages: draft.sampleImages.filter((x) => x !== rel) })}
                          >
                            <DeleteOutlined />
                          </button>
                        </div>
                      ))}
                    </Space>
                  )}
                </Space>
              )
            }
          ]}
        />
      </Card>

      <AiRubricModal
        open={aiOpen}
        busy={aiBusy}
        defaultTotal={config.scoreConfig.total}
        onCancel={() => setAiOpen(false)}
        onGenerated={(text) => {
          update({ rubric: text })
          setAiOpen(false)
          void message.success('已生成评分细则，可在此基础上编辑修改')
        }}
        onBusy={setAiBusy}
      />
    </div>
  )
}

// ---------------- 子组件 ----------------

/** 编辑 + 实时预览：宽容器双栏；窄容器（侧边栏）编辑/预览切换；粘贴截图由页面级监听统一处理 */
function EditPane({
  value,
  onChange,
  rows,
  placeholder,
  tabKey,
  onTaFocus
}: {
  value: string
  onChange: (v: string) => void
  rows: number
  placeholder: string
  tabKey: string
  onTaFocus: (key: string, el: HTMLTextAreaElement) => void
}) {
  const narrow = useNarrow()
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')

  const hint = (
    <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
      支持 Markdown / LaTeX（行内 $x^2$ / 独立 $$\int x\,dx$$）；窗口内直接 Ctrl+V 粘贴截图：文字自动转 Markdown，图形嵌入原图
    </Text>
  )

  const ta = (
    <Input.TextArea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => onTaFocus(tabKey, e.target as HTMLTextAreaElement)}
      rows={rows}
      placeholder={placeholder}
    />
  )

  if (narrow) {
    return (
      <div>
        <Segmented
          block
          value={mode}
          onChange={(v) => setMode(v as 'edit' | 'preview')}
          options={[
            { label: '编辑', value: 'edit' },
            { label: '预览', value: 'preview' }
          ]}
          style={{ marginBottom: 8 }}
        />
        {mode === 'edit' ? (
          <>
            {ta}
            {hint}
          </>
        ) : (
          <div className="md-preview-pane">
            <Markdown text={value} />
          </div>
        )}
      </div>
    )
  }

  return (
    <Row gutter={12}>
      <Col span={12}>
        {ta}
        {hint}
      </Col>
      <Col span={12}>
        <div className="md-preview-pane">
          <Markdown text={value} />
        </div>
      </Col>
    </Row>
  )
}

/** 加载 userData 中的标准参考图 */
function StandardImage({ rel }: { rel: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    void window.api
      .loadStandardImage(rel)
      .then((r) => {
        if (typeof r === 'string') setUrl(r)
      })
      .catch(() => {
        /* 图片缺失时忽略 */
      })
  }, [rel])
  if (!url) return null
  return <Image src={url} width={94} height={94} style={{ objectFit: 'contain' }} preview />
}

/** AI 自动生成评分细则弹窗 */
function AiRubricModal({
  open,
  busy,
  defaultTotal,
  onCancel,
  onGenerated,
  onBusy
}: {
  open: boolean
  busy: boolean
  defaultTotal: number
  onCancel: () => void
  onGenerated: (text: string) => void
  onBusy: (b: boolean) => void
}) {
  const [grade, setGrade] = useState('高三')
  const [subject, setSubject] = useState('数学')
  const [questionType, setQuestionType] = useState('解答题')
  const [total, setTotal] = useState(defaultTotal)
  const [stem, setStem] = useState('')
  const [answer, setAnswer] = useState('')
  const [extra, setExtra] = useState('')
  const { message } = AntdApp.useApp()
  const narrow = useNarrow()

  const run = async () => {
    onBusy(true)
    try {
      const text = unwrap<string>(
        await window.api.generateRubric({
          grade,
          subject,
          questionType,
          questionStem: stem,
          referenceAnswer: answer,
          totalScore: total,
          extraRequirement: extra
        })
      )
      onGenerated(text)
    } catch (err) {
      void message.error(`生成失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      onBusy(false)
    }
  }

  return (
    <Modal
      title="AI 自动生成评分细则"
      open={open}
      onCancel={onCancel}
      footer={null}
      width="94%"
      destroyOnClose
    >
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        将使用当前工作流的评分模型（文本模型）起草。题干与参考答案越完整，细则越贴合。
      </Paragraph>
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <Row gutter={10}>
          <Col span={narrow ? 12 : 6}>
            <Text style={{ fontSize: 12 }}>年段</Text>
            <Input value={grade} onChange={(e) => setGrade(e.target.value)} />
          </Col>
          <Col span={narrow ? 12 : 6}>
            <Text style={{ fontSize: 12 }}>学科</Text>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Col>
          <Col span={narrow ? 12 : 6}>
            <Text style={{ fontSize: 12 }}>题型</Text>
            <Input value={questionType} onChange={(e) => setQuestionType(e.target.value)} />
          </Col>
          <Col span={narrow ? 12 : 6}>
            <Text style={{ fontSize: 12 }}>满分</Text>
            <InputNumber value={total} onChange={(v) => setTotal(Number(v) || total)} style={{ width: '100%' }} min={1} max={300} />
          </Col>
        </Row>
        <div>
          <Text style={{ fontSize: 12 }}>题目题干（可选）</Text>
          <Input.TextArea value={stem} onChange={(e) => setStem(e.target.value)} rows={3} placeholder="粘贴题目原文，公式可用 LaTeX" />
        </div>
        <div>
          <Text style={{ fontSize: 12 }}>参考答案（可选）</Text>
          <Input.TextArea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} />
        </div>
        <div>
          <Text style={{ fontSize: 12 }}>其他要求（可选）</Text>
          <Input.TextArea value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} placeholder="例：重点考查第二问；错别字不扣分" />
        </div>
        <Space>
          <Button type="primary" loading={busy} icon={<AimOutlined />} onClick={() => void run()}>
            开始生成
          </Button>
          <Button icon={<ExportOutlined />} onClick={onCancel}>
            取消
          </Button>
        </Space>
      </Space>
    </Modal>
  )
}
