import { useEffect, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Modal,
  Space,
  Spin,
  Tag,
  Typography
} from 'antd'
import { AimOutlined, CameraOutlined, DeleteOutlined, ExperimentOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { AutoLocateResult, Region, RegionKind } from '@shared/types'
import { useConfigStore } from '@renderer/stores/config'
import { genId, unwrap } from '@renderer/utils'
import Hint from '@renderer/settings/Hint'

const { Text, Title, Paragraph } = Typography

interface RegionDef {
  kind: RegionKind
  label: string
  how: string
  desc: string
}

const REGION_DEFS: RegionDef[] = [
  {
    kind: 'answer',
    label: '答题区域',
    how: '矩形框选',
    desc: '批改时循环截取该区域作为题目图像提交 AI 识别评分。建议框住完整作答内容，不含无关区域以提升识别准确度。'
  },
  {
    kind: 'submit',
    label: '提交按钮',
    how: '单点点击',
    desc: '分数填写完成后自动点击提交，实现与现有阅卷系统的自动对接与翻页。'
  }
]

/** 答题区域标记：AI 一键定位（屏幕上调整确认） + 可视化框选/点击标记 + 截屏测试 + 自动化校准 */
export default function RegionsPage() {
  const { config, load, patch } = useConfigStore()
  const { message } = AntdApp.useApp()
  const [marking, setMarking] = useState<string | null>(null)
  const [shot, setShot] = useState<{ label: string; dataUrl?: string; error?: string } | null>(null)
  const [auto, setAuto] = useState<{ impl: string; ok: boolean; message: string } | null>(null)
  const [calibrating, setCalibrating] = useState(false)
  const [locating, setLocating] = useState(false)

  useEffect(() => {
    void window.api
      .getAutomationStatus()
      .then((s) => setAuto(s))
      .catch(() => setAuto(null))
  }, [])

  if (!config) return null

  const mark = async (def: RegionDef) => {
    setMarking(def.kind)
    try {
      const r = unwrap<Region | null>(await window.api.markRegion({ kind: def.kind }))
      await load()
      if (r) void message.success(`已标记「${def.label}」`)
      else void message.info('已取消标记')
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setMarking(null)
    }
  }

  // ---------- 分值输入框：多次标记按顺序作为小题 1/2/3… ----------
  const markScore = async () => {
    setMarking('score')
    try {
      const enabled = config.subQuestions.filter((s) => s.enabled)
      // 首次标记且无小题：作为整题分值框；再次标记时自动转为小题模式
      if (!enabled.length && !config.regions.score) {
        const r = unwrap<Region | null>(await window.api.markRegion({ kind: 'score' }))
        await load()
        if (r) void message.success('已标记整题分值框；如需分小题，请继续标记小题 1/2/3… 各分值框')
        else void message.info('已取消标记')
        return
      }
      let regions = { ...config.regions }
      let subs = config.subQuestions.map((s) => ({ ...s }))
      // 整题分值框 → 转为小题1，本次标记小题2
      if (!subs.filter((s) => s.enabled).length && regions.score) {
        const id1 = genId('sub')
        const regionId1 = `sub:${id1}`
        regions[regionId1] = { ...regions.score, id: regionId1, label: '小题1 分值框' }
        delete regions.score
        subs.push({
          id: id1,
          name: '小题1',
          enabled: true,
          scoreBoxId: regionId1,
          maxScore: 0,
          minScore: 0,
          step: 1,
          rulesPrompt: ''
        })
      }
      const nextIdx = subs.filter((s) => s.enabled).length + 1
      const id = genId('sub')
      const regionId = `sub:${id}`
      const r = unwrap<Region | null>(
        await window.api.markRegion({ kind: 'score', id: regionId, label: `小题${nextIdx} 分值框` })
      )
      if (!r) {
        void message.info('已取消标记')
        return
      }
      regions[regionId] = r
      subs.push({
        id,
        name: `小题${nextIdx}`,
        enabled: true,
        scoreBoxId: regionId,
        maxScore: 0,
        minScore: 0,
        step: 1,
        rulesPrompt: ''
      })
      // 重新平均：每题满分 = 总分值 ÷ 题数（0.5 步进取整）
      const n = subs.filter((s) => s.enabled).length
      const perMax =
        config.scoreConfig.total > 0
          ? Math.max(0.5, Math.round((config.scoreConfig.total / n) * 2) / 2)
          : 1.5
      const perStep = perMax % 1 === 0 ? 1 : 0.5
      subs = subs.map((s) => (s.enabled ? { ...s, maxScore: perMax, step: perStep } : s))
      await patch({ regions, subQuestions: subs })
      await load()
      void message.success(`已标记小题${nextIdx} 分值框（共 ${n} 个小题，每题 ${perMax} 分）`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setMarking(null)
    }
  }

  const clearScore = async () => {
    const regions = { ...config.regions }
    delete regions.score
    for (const k of Object.keys(regions)) {
      if (k.startsWith('sub:')) delete regions[k]
    }
    await patch({ regions, subQuestions: [] })
    await load()
    void message.success('已清除全部分值标记，可重新标记')
  }

  const testCapture = async (def: RegionDef) => {
    const kind = def.kind
    const r = unwrap<{ ok: boolean; dataUrl?: string; error?: string }>(
      await window.api.testRegionCapture(kind)
    )
    if (r.ok && r.dataUrl) setShot({ label: def.label, dataUrl: r.dataUrl })
    else void message.error(r.error ?? '截屏失败')
  }

  const calibrate = async () => {
    setCalibrating(true)
    try {
      const r = unwrap<{ impl: string; ok: boolean; message: string }>(
        await window.api.calibrateAutomation()
      )
      setAuto(r)
      if (r.ok) void message.success(`键鼠自动化可用：${r.message}`)
      else void message.warning(`校准未通过：${r.message}`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCalibrating(false)
    }
  }

  // ---------- AI 一键定位 ----------
  const runLocate = async () => {
    setLocating(true)
    try {
      const r = unwrap<AutoLocateResult>(await window.api.autoLocateRegions())
      if (!r.ok || !r.regions) {
        void message.error(r.error ?? '一键定位失败，请重试或改用手动标记')
        return
      }
      // 定位框直接显示在屏幕元素上，手动调整后确认
      const adjustBoxes = Object.values(r.regions).map((v) => ({
        key: v.id,
        label: v.label,
        rect: v.rect
      }))
      const adjusted = await window.api.adjustRegionBoxes(adjustBoxes)
      if (!adjusted) {
        void message.info('已取消，未保存定位结果')
        return
      }
      const regions = { ...r.regions }
      for (const [k, rect] of Object.entries(adjusted)) {
        if (regions[k]) regions[k] = { ...regions[k], rect }
      }
      await applyLocate({ ...r, regions })
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLocating(false)
    }
  }

  const applyLocate = async (res: AutoLocateResult) => {
    if (!res.regions) return
    const regions = { ...config.regions }
    // 分小题场景：平台提交小题分后自动累计总分，移除整题总分框
    if (res.dropScore) delete regions.score
    // 清理未被新小题引用的旧 sub:* 区域，避免残留旧坐标干扰后续定位/批改
    if (res.subQuestions) {
      const refIds = new Set(res.subQuestions.map((s) => s.scoreBoxId).filter((v): v is string => !!v))
      for (const k of Object.keys(regions)) {
        if (k.startsWith('sub:') && !refIds.has(k)) delete regions[k]
      }
    }
    const applied: string[] = []
    for (const v of Object.values(res.regions)) {
      if (v) {
        regions[v.id] = v
        applied.push(v.label)
      }
    }
    const p: Record<string, unknown> = { regions }
    if (res.subQuestions) p.subQuestions = res.subQuestions
    await patch(p)
    const subInfo = res.subBound
      ? `；已自动创建 ${res.subBound} 个小题（每题满分 = 总分值 ÷ 题数，可在「分值配置」页调整总分值）`
      : ''
    const dropInfo = res.dropScore ? '；小题分值提交后平台自动累计总分，无需整题总分框' : ''
    void message.success(`已保存：${applied.join('、')}${subInfo}${dropInfo}`)
    if (res.missing?.length) {
      void message.warning(`未识别：${res.missing.join('、')}，请在下方对应卡片手动标记`)
    }
  }

  return (
    <div>
      <Title level={4} className="page-title">
        答题区域标记
      </Title>
      <Paragraph className="page-desc">
        标记答题区域、分值输入框与提交按钮，批改时自动完成「截题 → 评分 → 填分 → 提交」；全屏遮罩中 <b>ESC</b> 可取消。
      </Paragraph>

      <Hint
        text="标记前先把阅卷系统窗口调到实际批改位置与缩放；移动/缩放窗口后需重新标记。"
        detail={
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            <li>多显示器会为每个屏幕弹出标记层，请在目标屏幕操作。</li>
            <li>自动填分无效时，点下方「自动化校准」重新探测键鼠模拟方案。</li>
          </ul>
        }
      />

      <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 10 }}>
        {/* AI 一键定位 */}
        <Card
          size="small"
          title={
            <Space size={6}>
              <ThunderboltOutlined style={{ color: '#1677ff' }} />
              <span>AI 一键定位</span>
            </Space>
          }
          styles={{ body: { padding: '10px 12px' } }}
        >
          <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            自动截屏识别答题区域、分值输入框、提交按钮（智学网等平台），识别结果直接在屏幕元素上显示定位框：拖动框体移动、拖动圆点调整大小，确认后保存；检测到多个分数输入框时自动分小题。使用批改工作流配置的识别模型，需先配置可用的多模态模型。
          </Text>
          <Button
            block
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={locating}
            onClick={() => void runLocate()}
            style={{ marginTop: 10 }}
          >
            {locating ? '正在截屏识别（约 5–30 秒）…' : '一键定位'}
          </Button>
        </Card>

        {/* 区域标记 */}
        {REGION_DEFS.map((def) => {
          const r = config.regions[def.kind]
          return (
            <Card
              key={def.kind}
              size="small"
              title={
                <Space size={6} wrap>
                  <span>{def.label}</span>
                  <Tag
                    color={
                      def.kind === 'answer'
                        ? 'blue'
                        : def.kind === 'score'
                          ? 'green'
                          : 'orange'
                    }
                  >
                    {def.how}
                  </Tag>
                  {r ? <Tag color="success">已标记</Tag> : <Tag color="error">未标记</Tag>}
                </Space>
              }
              styles={{ body: { padding: '10px 12px' } }}
            >
              <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                {def.desc}
              </Text>
              {r && (
                <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
                  <Descriptions.Item label="位置">
                    ({Math.round(r.rect.x)}, {Math.round(r.rect.y)})
                  </Descriptions.Item>
                  <Descriptions.Item label="尺寸">
                    {Math.round(r.rect.w)} × {Math.round(r.rect.h)}
                  </Descriptions.Item>
                  <Descriptions.Item label="屏幕缩放">{r.scaleAtMark}x</Descriptions.Item>
                  <Descriptions.Item label="显示器">#{r.displayId}</Descriptions.Item>
                </Descriptions>
              )}
              <Space size={8} style={{ marginTop: 10 }}>
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={r ? <ReloadOutlined /> : <AimOutlined />}
                  loading={marking === def.kind}
                  onClick={() => void mark(def)}
                >
                  {r ? '重新标记' : '开始标记'}
                </Button>
                <Button
                  size="small"
                  icon={<CameraOutlined />}
                  disabled={!r}
                  onClick={() => void testCapture(def)}
                >
                  截屏测试
                </Button>
              </Space>
            </Card>
          )
        })}

        {/* 分值输入框：多次标记按顺序作为小题 1/2/3… */}
        <Card
          size="small"
          title={
            <Space size={6} wrap>
              <span>分值输入框</span>
              <Tag color="green">单点点击 · 可多次</Tag>
              {(() => {
                const subCnt = config.subQuestions.filter((s) => s.enabled).length
                if (subCnt) return <Tag color="success">已标记 {subCnt} 个小题分值框</Tag>
                return config.regions.score ? (
                  <Tag color="success">已标记（整题）</Tag>
                ) : (
                  <Tag color="error">未标记</Tag>
                )
              })()}
            </Space>
          }
          styles={{ body: { padding: '10px 12px' } }}
        >
          <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            标记一次 = 整题分值框；继续标记则按顺序作为小题 1/2/3…
            各自的分值框，每题满分自动按「总分值 ÷ 题数」平均分配。标记错位时点「清除」重新开始。
          </Text>
          <Space size={8} style={{ marginTop: 10 }}>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<AimOutlined />}
              loading={marking === 'score'}
              onClick={() => void markScore()}
            >
              {(() => {
                const subCnt = config.subQuestions.filter((s) => s.enabled).length
                if (subCnt) return `标记小题${subCnt + 1} 分值框`
                return config.regions.score ? '继续标记（转为分小题）' : '开始标记'
              })()}
            </Button>
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={!config.regions.score && !config.subQuestions.some((s) => s.enabled)}
              onClick={() => void clearScore()}
            >
              清除
            </Button>
          </Space>
        </Card>

        {/* 自动化 */}
        <Card
          size="small"
          title="键鼠自动化状态"
          styles={{ body: { padding: '10px 12px' } }}
        >
          {auto ? (
            <div>
              <Space size={6} wrap>
                <Tag color={auto.ok ? 'success' : 'error'}>{auto.impl === 'nut' ? '原生键鼠驱动' : '系统脚本键鼠'}</Tag>
              </Space>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                {auto.message}
              </Text>
            </div>
          ) : (
            <Spin size="small" />
          )}
          <Button
            size="small"
            block
            icon={<ExperimentOutlined />}
            loading={calibrating}
            onClick={() => void calibrate()}
            style={{ marginTop: 10 }}
          >
            自动化校准
          </Button>
        </Card>
      </Space>

      {/* 截屏测试结果 */}
      <Modal
        open={!!shot}
        title={`「${shot?.label ?? ''}」截屏测试`}
        footer={null}
        onCancel={() => setShot(null)}
        width="94%"
      >
        {shot?.dataUrl && <img className="region-shot" src={shot.dataUrl} alt="区域截屏" />}
        <Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
          请确认截屏内容完整清晰。若出现偏移、黑屏或截错屏幕，请重新标记或调整阅卷系统窗口位置。
        </Paragraph>
      </Modal>
    </div>
  )
}
