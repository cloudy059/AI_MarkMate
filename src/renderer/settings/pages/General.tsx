import { useEffect, useState } from 'react'
import { App as AntdApp, Button, Col, Input, Popconfirm, Row, Space, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useConfigStore } from '@renderer/stores/config'

const { Text } = Typography

/** 通用设置内容：全局快捷键与常用维护操作（渲染在主页可收缩卡片内） */
export default function GeneralSettings() {
  const { config, patch } = useConfigStore()
  const { message } = AntdApp.useApp()
  const [hotkey, setHotkey] = useState('')

  useEffect(() => {
    setHotkey(config?.settings.hotkeyToggle ?? '')
  }, [config?.settings.hotkeyToggle])

  if (!config) return null

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
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div>
        <Text style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>侧边栏呼出快捷键</Text>
        <Row gutter={[8, 8]}>
          <Col span={16}>
            <Input
              size="small"
              value={hotkey}
              onChange={(e) => setHotkey(e.target.value)}
              placeholder="例如 Control+Shift+G"
            />
          </Col>
          <Col span={8}>
            <Button size="small" block type="primary" onClick={() => void saveHotkey()}>
              保存
            </Button>
          </Col>
        </Row>
        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
          格式：Control / Command / Alt / Shift / 字母或数字，加号连接，如 CommandOrControl+Alt+J
        </Text>
      </div>
      <Space wrap>
        <Popconfirm
          title="重启应用？"
          description="用于切换键鼠自动化方案或应用更新后生效"
          onConfirm={() => window.api.relaunchApp()}
        >
          <Button size="small" icon={<ReloadOutlined />}>
            重启应用
          </Button>
        </Popconfirm>
        <Popconfirm title="退出应用？" description="托盘与后台批改将一并结束。" onConfirm={() => window.api.quitApp()}>
          <Button size="small" danger>
            退出
          </Button>
        </Popconfirm>
      </Space>
    </Space>
  )
}
