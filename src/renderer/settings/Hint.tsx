import { Popover, Typography } from 'antd'
import type { ReactNode } from 'react'

const { Text } = Typography

/** 单行紧凑提示：长说明默认折叠，点「详情」浮层展开 */
export default function Hint({ text, detail }: { text: ReactNode; detail?: ReactNode }) {
  return (
    <Text type="secondary" style={{ fontSize: 12, display: 'block', lineHeight: '18px' }}>
      {text}
      {detail !== undefined && (
        <Popover
          trigger="click"
          content={<div style={{ maxWidth: 280, fontSize: 12, lineHeight: 1.7 }}>{detail}</div>}
        >
          <a style={{ marginLeft: 6, fontSize: 12 }}>详情</a>
        </Popover>
      )}
    </Text>
  )
}
