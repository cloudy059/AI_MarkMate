import { useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  List,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography
} from 'antd'
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SyncOutlined
} from '@ant-design/icons'
import type { LanNode, ProviderConfig, TestResult } from '@shared/types'
import { useConfigStore } from '@renderer/stores/config'
import { VENDOR_INFO, isLocalKind, unwrap } from '@renderer/utils'

const { Text, Title, Paragraph } = Typography

/** AI 服务商配置：云端/本机服务商编辑与连接测试 + 局域网分布式节点管理 */
export default function ProvidersPage() {
  const { config, load, patch } = useConfigStore()
  const { message } = AntdApp.useApp()
  const [editing, setEditing] = useState<ProviderConfig | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ id: string; r: TestResult } | null>(null)
  const [lanModal, setLanModal] = useState<LanNode | null>(null)
  const [lanTest, setLanTest] = useState<{ id: string; r: TestResult } | null>(null)

  if (!config) return null

  const saveProvider = async (p: ProviderConfig) => {
    await patch({ providers: config.providers.map((x) => (x.id === p.id ? p : x)) })
    setEditing(null)
    void message.success('已保存')
  }

  const runTest = async (p: ProviderConfig) => {
    setTestingId(p.id)
    setTestResult(null)
    try {
      const r = unwrap<TestResult>(await window.api.testProvider(p.id))
      setTestResult({ id: p.id, r })
      if (r.ok) void message.success(`${p.name} 连接成功（${r.latencyMs}ms）`)
      else void message.error(`${p.name} 连接失败`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setTestingId(null)
    }
  }

  const runLanTest = async (node: LanNode) => {
    try {
      const r = unwrap<TestResult>(await window.api.testLanNode(node))
      setLanTest({ id: node.id, r })
      if (r.ok) void message.success(`节点「${node.name}」连接成功（${r.latencyMs}ms）`)
      else void message.error(`节点「${node.name}」连接失败`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const healthAll = async () => {
    try {
      unwrap(await window.api.checkLanHealth())
      await load()
      void message.success('局域网健康检查完成')
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const removeLan = async (id: string) => {
    try {
      unwrap(await window.api.removeLanNode(id))
      await load()
      void message.success('节点已删除')
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div>
      <Title level={4} className="page-title">
        AI 服务商配置
      </Title>
      <Paragraph className="page-desc">
        云端官方 API / 本机本地推理 / 局域网节点三种评分来源；填好密钥后请点「测试连接」验证。
      </Paragraph>

      {/* 服务商列表 */}
      <Card title="服务商列表（云端 + 本机）" styles={{ body: { padding: '4px 16px' } }}>
        <List
          dataSource={config.providers}
          renderItem={(p) => {
            const info = VENDOR_INFO[p.kind] ?? { name: p.kind, hint: '', fixedUrl: false, local: false, hasVision: true }
            const keyReady = isLocalKind(p.kind) || p.kind === 'custom' ? true : Boolean(p.apiKey.trim())
            const t = testResult?.id === p.id ? testResult.r : null
            return (
              <List.Item style={{ display: 'block', padding: '5px 0' }}>
                {/* 单行：开关 + 名称 + 状态标签 + 操作按钮（右侧） */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                  <Switch
                    checked={p.enabled}
                    onChange={(v) => void patch({ providers: config.providers.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)) })}
                  />
                  <Text strong>{p.name}</Text>
                  <Tag color={info.local ? 'geekblue' : 'blue'}>{info.local ? '本机' : '云端'}</Tag>
                  {!keyReady && p.enabled && <Tag color="warning">未填密钥</Tag>}
                  {t && (t.ok ? <Tag color="success" icon={<CheckCircleOutlined />}>{t.latencyMs}ms</Tag> : <Tag color="error" icon={<CloseCircleOutlined />}>失败</Tag>)}
                  <Space size={6} style={{ marginLeft: 'auto' }}>
                    <Button
                      size="small"
                      icon={<ApiOutlined />}
                      loading={testingId === p.id}
                      onClick={() => void runTest(p)}
                    >
                      测试
                    </Button>
                    <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(p)}>
                      配置
                    </Button>
                  </Space>
                </div>
              </List.Item>
            )
          }}
        />
      </Card>

      {/* 局域网节点 */}
      <Card
        title="局域网分布式评分节点"
        style={{ marginTop: 16 }}
        styles={{ body: { padding: '10px 12px' } }}
      >
        <Space size={8} style={{ marginBottom: 10 }}>
          <Button size="small" icon={<SyncOutlined />} onClick={() => void healthAll()}>
            健康检查
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() =>
              setLanModal({ id: `lan_${Date.now().toString(36)}`, name: '', baseUrl: 'http://192.168.1.100:11434', kind: 'ollama', apiKey: '', enabled: true, health: { ok: false, rttMs: 0, checkedAt: 0, models: [] } })
            }
          >
            添加节点
          </Button>
        </Space>
        {config.lanNodes.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            尚未添加节点。添加局域网内其他主机部署的服务后，可在「模型与评分标准」中选择局域网作为评分来源。
          </Text>
        ) : (
          <List
            dataSource={config.lanNodes}
            renderItem={(n) => (
              <List.Item style={{ display: 'block', padding: '5px 0' }}>
                <List.Item.Meta
                  title={
                    <Space size={6} wrap>
                      <Text strong>{n.name || n.baseUrl}</Text>
                      <Tag>{n.kind}</Tag>
                      <Tag color={n.health.ok ? 'success' : 'default'}>
                        {n.health.ok ? `健康 ${n.health.rttMs}ms` : '未连通'}
                      </Tag>
                    </Space>
                  }
                  description={
                    <Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                      {n.baseUrl}
                      {n.health.models.length > 0 && ` · 可用模型 ${n.health.models.length} 个`}
                      {lanTest?.id === n.id && !lanTest.r.ok && ` · ${lanTest.r.error}`}
                    </Text>
                  }
                />
                <Space size={8} style={{ marginTop: 4 }}>
                  <Switch
                    checked={n.enabled}
                    onChange={(v) => void window.api.upsertLanNode({ ...n, enabled: v }).then(unwrap).then(() => load())}
                  />
                  <Button size="small" icon={<ApiOutlined />} onClick={() => void runLanTest(n)}>
                    测试
                  </Button>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void removeLan(n.id)} />
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 服务商编辑抽屉 */}
      <Drawer
        title={editing ? `配置：${editing.name}` : ''}
        width="94%"
        open={!!editing}
        onClose={() => setEditing(null)}
        destroyOnClose
        styles={{ body: { padding: '12px 14px' } }}
      >
        {editing && (
          <ProviderForm
            provider={editing}
            onSave={(p) => void saveProvider(p)}
            onCancel={() => setEditing(null)}
          />
        )}
      </Drawer>

      {/* 局域网节点编辑 */}
      <Drawer
        title="局域网节点"
        width="94%"
        open={!!lanModal}
        onClose={() => { setLanModal(null); setLanTest(null) }}
        destroyOnClose
        styles={{ body: { padding: '12px 14px' } }}
      >
        {lanModal && (
          <LanForm
            node={lanModal}
            onSave={(n) =>
              void window.api
                .upsertLanNode(n)
                .then(unwrap)
                .then(async () => {
                  await load()
                  setLanModal(null)
                  void message.success('节点已保存')
                })
                .catch((err: unknown) => message.error(err instanceof Error ? err.message : String(err)))
            }
            onTest={(n) => void runLanTest(n)}
            testResult={lanTest?.id === lanModal.id ? lanTest.r : null}
            onCancel={() => setLanModal(null)}
          />
        )}
      </Drawer>
    </div>
  )
}

// ---------------- 表单子组件 ----------------

function ProviderForm({
  provider,
  onSave,
  onCancel
}: {
  provider: ProviderConfig
  onSave: (p: ProviderConfig) => void
  onCancel: () => void
}) {
  const [form] = Form.useForm<ProviderConfig>()
  const info = VENDOR_INFO[provider.kind]
  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={provider}
      onFinish={(v) => onSave({ ...provider, ...v })}
    >
      {info?.hint && <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>{info.hint}</Text>}
      <Form.Item name="name" label="显示名称" rules={[{ required: true, message: '请输入名称' }]}>
        <Input />
      </Form.Item>
      <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, message: '请输入接口地址' }]} extra={info?.fixedUrl ? '官方固定地址，通常无需修改' : '自定义地址可修改'}>
        <Input disabled={info?.fixedUrl} placeholder="https://... （OpenAI 兼容地址一般以 /v1 结尾）" />
      </Form.Item>
      <Form.Item
        name="apiKey"
        label="API 密钥（Key）"
        extra={
          isLocalKind(provider.kind) ? (
            '本机服务无需密钥'
          ) : (
            <span>
              必填，请到对应开放平台控制台获取
              {info?.consoleUrl && (
                <>
                  <br />
                  <a
                    style={{ wordBreak: 'break-all' }}
                    onClick={(e) => {
                      e.preventDefault()
                      const url = info?.consoleUrl
                      if (url) window.api.openExternal(url)
                    }}
                  >
                    {info.consoleUrl}
                  </a>
                </>
              )}
            </span>
          )
        }
      >
        <Input.Password autoComplete="new-password" placeholder={isLocalKind(provider.kind) ? '（无需填写）' : 'sk-...'} />
      </Form.Item>
      <Row gutter={12}>
        <Col span={24}>
          <Form.Item name="chatModel" label="文本评分模型" rules={[{ required: true, message: '请填写文本评分模型' }]}>
            <Input placeholder="例：qwen-plus / deepseek-chat" />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item name="visionModel" label="多模态识图/直评模型" extra="模式 A（多模态直评）与视觉识别使用；无视觉能力的厂商可留空">
        <Input placeholder="例：qwen-vl-max / glm-4v-flash" />
      </Form.Item>
      <Form.Item name="ocrModel" label="OCR 专用模型（可选）" extra="留空则使用多模态模型执行 OCR">
        <Input placeholder="例：qwen-vl-ocr / glm-4v-ocr" />
      </Form.Item>
      <Row gutter={12}>
        <Col span={12}>
          <Form.Item name="timeoutMs" label="超时时间（毫秒）">
            <InputNumber style={{ width: '100%' }} min={10_000} max={600_000} step={10_000} />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item name="enabled" label="启用该服务商" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Col>
      </Row>
      <Space>
        <Button type="primary" htmlType="submit" icon={<SafetyCertificateOutlined />}>
          保存
        </Button>
        <Button onClick={onCancel}>取消</Button>
      </Space>
    </Form>
  )
}

function LanForm({
  node,
  onSave,
  onTest,
  onCancel,
  testResult
}: {
  node: LanNode
  onSave: (n: LanNode) => void
  onTest: (n: LanNode) => void
  onCancel: () => void
  testResult: TestResult | null
}) {
  const [form] = Form.useForm<LanNode>()
  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={node}
      onFinish={(v) => onSave({ ...node, ...v, health: node.health })}
    >
      <Form.Item name="name" label="节点名称" rules={[{ required: true, message: '请输入节点名称' }]}>
        <Input placeholder="例：书房主机 Ollama" />
      </Form.Item>
      <Form.Item name="kind" label="节点类型" rules={[{ required: true }]}>
        <Select
          options={[
            { label: 'Ollama（/api/chat 协议）', value: 'ollama' },
            { label: 'LM Studio（OpenAI 兼容）', value: 'lmstudio' },
            { label: 'OpenAI 兼容服务（vLLM / 中转等）', value: 'openai' }
          ]}
        />
      </Form.Item>
      <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, message: '请输入局域网接口地址' }]} extra="局域网内其他主机上部署的服务地址">
        <Input placeholder="http://192.168.1.100:11434（Ollama）/ http://192.168.1.100:1234/v1（LM Studio）" />
      </Form.Item>
      <Form.Item name="apiKey" label="API 密钥（可选）" extra="仅当节点设置了访问鉴权时填写">
        <Input.Password autoComplete="new-password" />
      </Form.Item>
      <Form.Item name="enabled" label="启用该节点" valuePropName="checked">
        <Switch />
      </Form.Item>
      {testResult && (
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="测试结果">
            {testResult.ok ? (
              <Tag color="success">连接成功 · {testResult.latencyMs}ms · 模型 {testResult.models.length} 个</Tag>
            ) : (
              <Tag color="error">失败：{testResult.error}</Tag>
            )}
          </Descriptions.Item>
          {testResult.ok && testResult.models.length > 0 && (
            <Descriptions.Item label="可用模型">
              <Text code style={{ fontSize: 11 }}>{testResult.models.slice(0, 30).join(' / ')}</Text>
            </Descriptions.Item>
          )}
        </Descriptions>
      )}
      <Space>
        <Button type="primary" htmlType="submit">
          保存
        </Button>
        <Button icon={<ApiOutlined />} onClick={() => onTest({ ...node, ...form.getFieldsValue() })}>
          测试连接
        </Button>
        <Button onClick={onCancel}>取消</Button>
      </Space>
    </Form>
  )
}
