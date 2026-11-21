import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Popconfirm,
  Select,
  Space,
  Typography
} from 'antd'
import {
  AimOutlined,
  ClearOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { ScoringStandard } from '@shared/types'
import { Markdown } from '@renderer/components/Markdown'
import { useConfigStore } from '@renderer/stores/config'
import { genId, unwrap, useNarrow } from '@renderer/utils'

const { Title, Paragraph } = Typography

type FieldKey = 'questionStem' | 'referenceAnswer' | 'rubric'

/** 顺序即界面顺序：题目题干 → 参考答案 → 评分标准 */
const FIELDS: { key: FieldKey; label: string; placeholder: string; icon: ReactNode }[] = [
  {
    key: 'questionStem',
    label: '题目题干',
    placeholder: '在此输入内容，或右键 / Ctrl+V 粘贴截图；支持表格与 LaTeX 公式…',
    icon: <FileTextOutlined />
  },
  {
    key: 'referenceAnswer',
    label: '参考答案',
    placeholder: '在此输入内容，或右键 / Ctrl+V 粘贴截图；支持表格与 LaTeX 公式…',
    icon: <EditOutlined />
  },
  {
    key: 'rubric',
    label: '评分标准',
    placeholder: '在此输入内容，或右键 / Ctrl+V 粘贴截图；支持表格与 LaTeX 公式…',
    icon: <AimOutlined />
  }
]

function emptyStd(): ScoringStandard {
  return {
    id: genId('std'),
    name: '',
    subject: '',
    grade: '',
    questionType: '',
    questionStem: '',
    referenceAnswer: '',
    rubric: '',
    enabled: false
  }
}

/** 评分标准管理：三字段点击即编辑、AI 依据题干+答案直接生成评分标准、10 套预设循环切换 */
export default function StandardsPage() {
  const { config, patch } = useConfigStore()
  const { message, modal } = AntdApp.useApp()
  const narrow = useNarrow()
  const [idx, setIdx] = useState(0)
  const [draft, setDraft] = useState<ScoringStandard>(emptyStd())
  const [aiBusy, setAiBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 当前编辑会话：token 校验结果归属，field 记录正在编辑的字段 */
  const tokenRef = useRef('')
  const fieldRef = useRef<FieldKey | null>(null)
  const slotRef = useRef(0)
  /** 结果回调需要读取最新状态，避免订阅时闭包过期 */
  const latestRef = useRef({ draft, config, idx, patch, message })
  latestRef.current = { draft, config, idx, patch, message }

  useEffect(() => {
    if (!config) return
    const s = config.scoringStandards[idx]
    setDraft(s ? { ...s } : emptyStd())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx])

  /** 独立编辑窗口保存后回写字段；取消 / 直接关窗（value=null）不改动内容 */
  useEffect(() => {
    return window.api.onRichTextResult((r) => {
      if (!tokenRef.current || r.token !== tokenRef.current) return
      tokenRef.current = ''
      const key = fieldRef.current
      fieldRef.current = null
      if (r.value === null || !key) return
      if (latestRef.current.idx !== slotRef.current) {
        void latestRef.current.message.warning('编辑期间切换了评分标准套，本次修改未写入')
        return
      }
      applyPatch({ [key]: r.value } as Partial<ScoringStandard>)
      const label = FIELDS.find((f) => f.key === key)?.label ?? '字段'
      void latestRef.current.message.success(`已保存「${label}」`)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!config) return null

  /** 更新当前套字段：立即刷新界面，350ms 防抖写入配置 */
  const applyPatch = (p: Partial<ScoringStandard>) => {
    const next = { ...latestRef.current.draft, ...p }
    latestRef.current.draft = next
    setDraft(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const snap = latestRef.current
      if (!snap.config) return
      const arr = snap.config.scoringStandards.slice()
      arr[snap.idx] = next
      void snap.patch({ scoringStandards: arr }).catch((err: unknown) =>
        snap.message.error(err instanceof Error ? err.message : String(err))
      )
    }, 350)
  }

  const clearSlot = async () => {
    if (timer.current) clearTimeout(timer.current)
    const arr = config.scoringStandards.slice()
    arr[idx] = null
    await patch({ scoringStandards: arr })
    setDraft(emptyStd())
    void message.success('已清空该套标准')
  }

  const slotOptions = config.scoringStandards.map((s, i) => {
    const brief =
      s?.name?.trim() ||
      s?.questionStem?.trim().replace(/\s+/g, ' ').slice(0, 14) ||
      ''
    return {
      label: `第 ${i + 1} 套${brief ? ` · ${brief}${s && s.questionStem.trim().length > 14 ? '…' : ''}` : ' · 空'}${i === config.activeStandardIndex ? '（启用）' : ''}`,
      value: i
    }
  })

  // 下拉选择某套即切换编辑并直接启用该套
  const selectSlot = (i: number) => {
    setIdx(i)
    if (i !== config.activeStandardIndex) void patch({ activeStandardIndex: i })
  }

  /** 点击字段内容区：在屏幕中央打开独立富文本编辑窗口 */
  const openEditor = (key: FieldKey): void => {
    const def = FIELDS.find((f) => f.key === key)
    if (!def) return
    const cur = latestRef.current.draft
    const token = genId('rte')
    tokenRef.current = token
    fieldRef.current = key
    slotRef.current = latestRef.current.idx
    void window.api.openRichText({
      token,
      title: `编辑 · ${def.label}`,
      value: cur[key],
      standardId: cur.id,
      placeholder: def.placeholder
    })
  }

  /** AI 生成评分标准：直接依据本套题干与参考答案，结果写入评分标准字段 */
  const runAiGenerate = async (): Promise<void> => {
    const cur = latestRef.current.draft
    if (!cur.questionStem.trim() && !cur.referenceAnswer.trim()) {
      void message.warning('请先填写题目题干或参考答案，再生成评分标准')
      return
    }
    setAiBusy(true)
    try {
      const text = unwrap<string>(
        await window.api.generateStandard({
          totalScore: latestRef.current.config?.scoreConfig.total ?? 100,
          questionStem: cur.questionStem,
          referenceAnswer: cur.referenceAnswer
        })
      )
      const md = text?.trim()
      if (!md) throw new Error('模型未返回内容')
      applyPatch({ rubric: md })
      void message.success('已生成评分标准并写入「评分标准」字段')
    } catch (err) {
      void message.error(`生成失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setAiBusy(false)
    }
  }

  const onAiClick = (): void => {
    if (latestRef.current.draft.rubric.trim()) {
      modal.confirm({
        title: '评分标准已有内容',
        content: 'AI 生成结果将覆盖当前评分标准，是否继续？',
        okText: '覆盖并生成',
        cancelText: '取消',
        onOk: () => void runAiGenerate()
      })
    } else {
      void runAiGenerate()
    }
  }

  return (
    <div>
      <Title level={4} className="page-title">
        评分标准管理
      </Title>
      <Paragraph className="page-desc">
        按「题目题干 → 参考答案 → 评分标准」填写，点击内容区即可编辑；最多 10 套。
      </Paragraph>

      {/* 套选择 */}
      <Card size="small" styles={{ body: { padding: 10 } }}>
        <Space wrap size={8}>
          <Select value={idx} onChange={selectSlot} options={slotOptions} style={{ width: narrow ? '100%' : 280 }} />
          <Popconfirm title="清空该套标准的全部内容？" onConfirm={() => void clearSlot()}>
            <Button size="small" danger icon={<ClearOutlined />}>
              清空
            </Button>
          </Popconfirm>
        </Space>
      </Card>

      {/* 三个字段：题目题干 → 参考答案 → 评分标准 */}
      {FIELDS.map((f) => {
        const content = draft[f.key]
        const filled = content.trim().length > 0
        return (
          <Card
            key={f.key}
            size="small"
            style={{ marginTop: 10 }}
            styles={{ body: { padding: 10 } }}
            title={
              <Space size={6}>
                {f.icon}
                <span>{f.label}</span>
              </Space>
            }
            extra={
              <Space size={4}>
                {f.key === 'rubric' && (
                  <Button
                    size="small"
                    icon={<ThunderboltOutlined />}
                    loading={aiBusy}
                    disabled={aiBusy}
                    onClick={onAiClick}
                  >
                    AI 生成
                  </Button>
                )}
                {filled && (
                  <Popconfirm
                    title={`清空「${f.label}」的内容？`}
                    onConfirm={() => applyPatch({ [f.key]: '' } as Partial<ScoringStandard>)}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="清空字段" />
                  </Popconfirm>
                )}
              </Space>
            }
          >
            <div
              className={`std-field-preview${filled ? '' : ' is-empty'}`}
              role="button"
              tabIndex={0}
              title="点击打开独立富文本编辑窗口"
              onClick={() => openEditor(f.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  openEditor(f.key)
                }
              }}
            >
              {filled ? (
                <Markdown text={content} />
              ) : (
                <span className="std-field-placeholder">点击此处编辑{f.label}…</span>
              )}
            </div>
          </Card>
        )
      })}
    </div>
  )
}
