import { useEffect, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Input,
  Popconfirm,
  Row,
  Space,
  Steps,
  Tag,
  Typography
} from 'antd'
import {
  ArrowRightOutlined,
  CheckCircleFilled,
  MinusCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { isStandardUsable } from '@shared/types'
import { useConfigStore } from '@renderer/stores/config'
import { isLocalKind } from '@renderer/utils'

const { Text, Title, Paragraph } = Typography

/** 使用引导：面向非技术用户的操作指引 + 配置完成度清单 + 快捷键设置 */
export default function OnboardingPage({ go }: { go: (page: string) => void }) {
  const { config, patch } = useConfigStore()
  const { message } = AntdApp.useApp()
  const [hotkey, setHotkey] = useState('')

  useEffect(() => {
    setHotkey(config?.settings.hotkeyToggle ?? '')
  }, [config?.settings.hotkeyToggle])

  if (!config) return null

  // 配置完成度
  const enabledCloud = config.providers.filter((p) => p.enabled && !isLocalKind(p.kind) && (p.kind === 'custom' ? Boolean(p.baseUrl) : p.apiKey.trim()))
  const enabledLocal = config.providers.filter((p) => p.enabled && isLocalKind(p.kind))
  const lanOk = config.lanNodes.filter((n) => n.enabled && n.health.ok)
  const hasModelSource = enabledCloud.length + enabledLocal.length + lanOk.length > 0
  const std = config.scoringStandards[config.activeStandardIndex]
  const stdOk = isStandardUsable(std)
  const subBound = config.subQuestions.some((s) => s.enabled && s.scoreBoxId && config.regions[s.scoreBoxId])
  // 分小题场景由小题分值框 + 提交按钮完成给分（无整题总分框）
  const regionsOk = Boolean(config.regions.answer && config.regions.submit && (config.regions.score || subBound))

  const checks = [
    { ok: hasModelSource, label: '至少配置并启用一个可用评分来源（云端 / 本机 / 局域网）', page: 'providers' },
    { ok: stdOk, label: '当前评分标准已包含内容（标准/题干/答案/要求/示例任一项）', page: 'standards' },
    { ok: regionsOk, label: '已标记答题区域与提交按钮（分值框：整题标记或分小题一键定位）', page: 'regions' }
  ]
  const allDone = checks.every((c) => c.ok)

  const saveHotkey = async () => {
    const h = hotkey.trim()
    if (!h) {
      void message.warning('快捷键不能为空')
      return
    }
    await patch({ settings: { hotkeyToggle: h } })
    void message.success(`快捷键已更新为 ${h}（立即生效）`)
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <Title level={4} className="page-title">
        使用引导
      </Title>
      <Paragraph className="page-desc">
        按以下四步完成准备，即可在侧边栏一键开始 AI 自动批改。每一步都有独立配置页面，点击「去配置」直达。
      </Paragraph>

      <Steps
        direction="vertical"
        size="small"
        current={-1}
        items={[
          {
            title: '第一步 · 配置 AI 服务商',
            description: (
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  云端填 API 密钥，本机启用 Ollama / LM Studio；配置后点「测试连接」验证。
                </Text>
                <Button size="small" icon={<ArrowRightOutlined />} onClick={() => go('providers')}>
                  去配置服务商
                </Button>
              </Space>
            )
          },
          {
            title: '第二步 · 配置模型与规则',
            description: (
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  选择评分 / 识别模型来源，编写全局评分规则；识别模式与批改节奏可在侧边栏首页随时切换。
                </Text>
                <Button size="small" icon={<ArrowRightOutlined />} onClick={() => go('workflow')}>
                  去配置模型与规则
                </Button>
              </Space>
            )
          },
          {
            title: '第三步 · 编写评分标准',
            description: (
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  五个子页任意一项有内容即可；支持「AI 自动生成」与粘贴截图识别。
                </Text>
                <Button size="small" icon={<ArrowRightOutlined />} onClick={() => go('standards')}>
                  去编写标准
                </Button>
              </Space>
            )
          },
          {
            title: '第四步 · 标记答题区域并试改',
            description: (
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  框选答题区域、标记分值框与提交按钮，先试改几题确认。
                </Text>
                <Button size="small" icon={<ArrowRightOutlined />} onClick={() => go('regions')}>
                  去标记区域
                </Button>
              </Space>
            )
          }
        ]}
        style={{ marginBottom: 24 }}
      />

      {/* 配置完成度 */}
      <Card title="配置完成度自检" size="small" styles={{ body: { padding: '8px 16px' } }}>
        {checks.map((c) => (
          <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            {c.ok ? (
              <CheckCircleFilled style={{ color: '#52c41a' }} />
            ) : (
              <MinusCircleOutlined style={{ color: '#ff4d4f' }} />
            )}
            <Text style={{ fontSize: 12, flex: 1 }}>{c.label}</Text>
            {!c.ok && (
              <Button size="small" type="link" onClick={() => go(c.page)}>
                去处理
              </Button>
            )}
          </div>
        ))}
        <Alert
          style={{ marginTop: 8 }}
          type={allDone ? 'success' : 'warning'}
          showIcon
          message={
            allDone
              ? '全部就绪：可在侧边栏点击「开始批改」（建议先使用试改模式）'
              : '存在未完成项：开始批改时引擎也会做最终校验并提示缺什么'
          }
        />
      </Card>

      {/* 快捷键与维护 */}
      <Card title="快捷键与维护" size="small" style={{ marginTop: 16 }} styles={{ body: { padding: '10px 12px' } }}>
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12, display: 'block' }}>侧边栏呼出/隐藏快捷键：</Text>
          <Row gutter={[8, 8]}>
            <Col span={17}>
              <Input
                style={{ width: '100%' }}
                value={hotkey}
                onChange={(e) => setHotkey(e.target.value)}
                placeholder="例如 Control+Shift+G"
              />
            </Col>
            <Col span={7}>
              <Button block type="primary" onClick={() => void saveHotkey()}>
                保存生效
              </Button>
            </Col>
          </Row>
          <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
            格式：Control / Command / Alt / Shift / 字母或数字，加号连接，如 CommandOrControl+Alt+J；保存后立即注册为全局快捷键。
          </Text>
          <Space>
            <Popconfirm
              title="重启应用？"
              description="用于切换键鼠自动化方案或应用更新后生效"
              onConfirm={() => window.api.relaunchApp()}
            >
              <Button size="small" icon={<ReloadOutlined />}>
                重启应用
              </Button>
            </Popconfirm>
            <Popconfirm title="退出应用？托盘与后台批改将一并结束。" onConfirm={() => window.api.quitApp()}>
              <Button size="small" danger>
                退出
              </Button>
            </Popconfirm>
          </Space>
        </Space>
      </Card>

      {/* 完成引导 */}
      {!config.onboardingDone && (
        <Card size="small" style={{ marginTop: 16 }} styles={{ body: { padding: '10px 12px' } }}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Space size={6} wrap>
              <Tag color="processing">首次使用</Tag>
              <Text style={{ fontSize: 12 }}>
                看完本页后可标记引导完成，之后从侧边栏「设置」菜单随时回到此页复习。
              </Text>
            </Space>
            <div>
              <Button
                size="small"
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={() => void patch({ onboardingDone: true }).then(() => message.success('引导已完成'))}
              >
                标记引导完成
              </Button>
            </div>
          </Space>
        </Card>
      )}

      <Paragraph type="secondary" style={{ fontSize: 11, marginTop: 12 }}>
        安全提示：配置中的 API 密钥仅保存在本机用户数据目录；使用本机 OCR 模式（模式 B）时作答图像全程不出本机。
      </Paragraph>
    </div>
  )
}
