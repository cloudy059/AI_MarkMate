import { useEffect, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

const STDIMG_PREFIX = 'stdimg://local/'

/** 放行评分标准内嵌图片的自定义协议（react-markdown 默认会过滤非 http 协议） */
export function mdUrlTransform(url: string): string {
  return url.startsWith('stdimg://') ? url : defaultUrlTransform(url)
}

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

/** Markdown（GFM 表格 / 任务列表 / 删除线）+ LaTeX 实时渲染预览 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  if (!text || !text.trim()) {
    return <div className={`md-body md-empty${className ? ` ${className}` : ''}`}>（暂无内容，支持 Markdown、表格与 LaTeX 公式）</div>
  }
  return (
    <div className={`md-body${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={mdUrlTransform}
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
