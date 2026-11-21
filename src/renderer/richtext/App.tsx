import { useEffect, useState } from 'react'
import { Spin } from 'antd'
import type { RichTextInitPayload } from '@shared/types'
import RichTextEditor from '@renderer/components/RichTextEditor'

/** 独立编辑窗口：从主进程接收初始化数据，保存/取消通过 IPC 回传给发起窗口 */
export default function App() {
  const [init, setInit] = useState<RichTextInitPayload | null>(null)

  useEffect(() => {
    window.api.onRichTextInit((data) => setInit(data))
  }, [])

  if (!init) {
    return (
      <div className="rte-loading">
        <Spin tip="正在加载编辑器…" />
      </div>
    )
  }

  return (
    <RichTextEditor
      key={init.token}
      title={init.title}
      value={init.value}
      standardId={init.standardId}
      placeholder={init.placeholder}
      onCancel={() => window.api.cancelRichText()}
      onSave={(md) => window.api.submitRichText(md)}
    />
  )
}
