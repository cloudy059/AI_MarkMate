import { useEffect, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

const STDIMG_PREFIX = 'stdimg://local/'

/** stdimg://local/<相对路径> → 通过 IPC 读取 userData/standards 下的图片并渲染 */
function StdImg({ rel, alt }: { rel: string; alt?: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let alive = true
    void window.api
      .loadStandardImage(rel)
      .then((r) => {
        if (alive && typeof r === 'string') setUrl(r)
      })
      .catch(() => {
        /* 图片缺失时忽略 */
      })
    return () => {
      alive = false
    }
  }, [rel])
  if (!url) return <span className="md-empty">（图片加载中…）</span>
  return <img src={url} alt={alt ?? ''} />
}

/** Markdown + LaTeX 实时渲染预览（stdimg:// 为本地评分标准嵌入图，经 IPC 加载） */
export function Markdown({ text }: { text: string }) {
  if (!text || !text.trim()) {
    return <div className="md-body md-empty">（暂无内容，支持 Markdown 与 LaTeX 公式）</div>
  }
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={(url) => (url.startsWith('stdimg://') ? url : defaultUrlTransform(url))}
        components={{
          img: ({ src, alt }) =>
            typeof src === 'string' && src.startsWith(STDIMG_PREFIX) ? (
              <StdImg rel={decodeURIComponent(src.slice(STDIMG_PREFIX.length))} alt={alt} />
            ) : (
              <img src={src} alt={alt ?? ''} />
            )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
