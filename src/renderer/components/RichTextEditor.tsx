import { useEffect, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import {
  App as AntdApp,
  Button,
  Dropdown,
  Input,
  InputNumber,
  Modal,
  Radio,
  Segmented,
  Space,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { renderToString as katexRender } from 'katex'
import {
  AimOutlined,
  BlockOutlined,
  BoldOutlined,
  CheckSquareOutlined,
  ClearOutlined,
  CloseOutlined,
  CodeOutlined,
  EditOutlined,
  EyeOutlined,
  FunctionOutlined,
  ItalicOutlined,
  LineOutlined,
  LinkOutlined,
  OrderedListOutlined,
  PictureOutlined,
  RedoOutlined,
  StrikethroughOutlined,
  TableOutlined,
  UndoOutlined,
  UnorderedListOutlined
} from '@ant-design/icons'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import type { RichTextPastePayload } from '@shared/types'
import { Markdown, mdUrlTransform } from '@renderer/components/Markdown'
import { unwrap } from '@renderer/utils'
import './rich-text.css'

const { Text } = Typography

type Mode = 'visual' | 'source' | 'preview'
type Action =
  | 'undo' | 'redo' | 'p' | 'h1' | 'h2' | 'h3'
  | 'bold' | 'italic' | 'strike' | 'clear'
  | 'ul' | 'ol' | 'task' | 'quote' | 'code' | 'codeblock' | 'hr'
  | 'link' | 'image' | 'formula' | 'table'
type DialogKind = 'link' | 'formula' | 'table' | null

export interface RichTextEditorProps {
  /** 窗口标题，如「编辑 · 题目题干」 */
  title: string
  /** Markdown 原文（评分标准字段的存储格式） */
  value: string
  /** 当前评分标准套 id，用于导入图片时的存放目录 */
  standardId: string
  placeholder?: string
  onCancel: () => void
  onSave: (markdown: string) => void
}

// ---------------------------------------------------------------------------
// Markdown ⇄ HTML 互转：可视化模式编辑 HTML，落盘与送模型始终是 Markdown
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Markdown → 可视化 HTML（与预览使用完全相同的插件链，含 GFM 表格与 KaTeX） */
function markdownToHtml(md: string): string {
  if (!md.trim()) return '<p><br></p>'
  try {
    return renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={mdUrlTransform}
      >
        {md}
      </ReactMarkdown>
    )
  } catch {
    return `<p>${escapeHtml(md).replace(/\n/g, '<br>')}</p>`
  }
}

let turndownService: TurndownService | null = null
function getTurndown(): TurndownService {
  if (turndownService) return turndownService
  const t = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---'
  })
  t.use(gfm)
  // 统一使用 GFM 双波浪删除线（与源码工具栏一致）
  t.addRule('strikethroughDouble', {
    filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
    replacement: (content) => `~~${content}~~`
  })
  // KaTeX 渲染节点 → 还原为 $...$ / $$...$$（Latex 原文在 MathML annotation 内）
  t.addRule('katex', {
    filter: (node) => {
      const el = node as HTMLElement
      return Boolean(el.classList && (el.classList.contains('katex-display') || el.classList.contains('katex')))
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? ''
      if (!tex) return ''
      return el.classList.contains('katex-display') ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`
    }
  })
  // 工具栏新插入的公式外层保留 LaTeX 原文，避免 KaTeX 解析异常时丢失公式
  t.addRule('rteMath', {
    filter: (node) => Boolean((node as HTMLElement).classList?.contains('rte-math')),
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const tex = el.getAttribute('data-tex') || ''
      if (!tex) return ''
      return el.getAttribute('data-display') === 'true' ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`
    }
  })
  // 可视化模式为预览把图片换成了 dataURL，data-stdimg 保存原始 stdimg:// 地址
  t.addRule('localImage', {
    filter: (node) => {
      const el = node as HTMLElement
      return (
        el.nodeName === 'IMG' &&
        (el.hasAttribute?.('data-stdimg') || (el.getAttribute?.('src') ?? '').startsWith('stdimg://'))
      )
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const src = el.getAttribute('data-stdimg') || el.getAttribute('src') || ''
      return `![${el.getAttribute('alt') || ''}](${src})`
    }
  })
  turndownService = t
  return t
}

/** 恢复公式内部被 Markdown 转义的字符（如 \* → *），并规整列表缩进 */
function restoreMathEscapes(md: string): string {
  return md
    .replace(/(\$\$[\s\S]*?\$\$|\$[^$\n]*?\$)/g, (m) => m.replace(/\\([*_`\[\]])/g, '$1'))
    .replace(/^(\s*)([-*+]|\d+\.)\s{2,}(?=\S)/gm, '$1$2 ')
    .replace(/^(\s*- \[[ xX]\])\s{2,}(?=\S)/gm, '$1 ')
}

function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return ''
  const md = getTurndown().turndown(html)
  return restoreMathEscapes(md).replace(/\n{3,}/g, '\n\n').trim()
}

/** 可视化 DOM 增强：公式设为不可编辑、内嵌图片换成本地 dataURL 以便显示 */
function enhanceEditorDom(root: HTMLElement | null): void {
  if (!root) return
  root.querySelectorAll<HTMLElement>('.katex, .katex-display').forEach((el) => {
    el.setAttribute('contenteditable', 'false')
  })
  root.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
    const src = img.getAttribute('src') || ''
    if (!src.startsWith('stdimg://local/')) return
    const rel = decodeURIComponent(src.slice('stdimg://local/'.length))
    img.setAttribute('data-stdimg', src)
    void window.api
      .loadStandardImage(rel)
      .then((r) => {
        if (typeof r === 'string' && img.isConnected) img.src = r
      })
      .catch(() => {
        /* 图片缺失时保留占位 */
      })
  })
}

function tableHtml(rows: number, cols: number): string {
  const head = Array.from({ length: cols }, (_, i) => `<th>列 ${i + 1}</th>`).join('')
  const body = Array.from(
    { length: rows },
    () => `<tr>${Array.from({ length: cols }, () => '<td>&nbsp;</td>').join('')}</tr>`
  ).join('')
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><p><br></p>`
}

function tableMarkdown(rows: number, cols: number): string {
  const head = `| ${Array.from({ length: cols }, (_, i) => `列 ${i + 1}`).join(' | ')} |`
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`
  const body = Array.from({ length: rows }, () => `| ${Array.from({ length: cols }, () => '　').join(' | ')} |`).join('\n')
  return `${head}\n${sep}\n${body}`
}

// ---------------------------------------------------------------------------
// 工具栏按钮
// ---------------------------------------------------------------------------

function TBtn({
  icon,
  title,
  onClick,
  disabled
}: {
  icon?: ReactNode
  title: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Tooltip title={title} mouseEnterDelay={0.4}>
      <Button
        size="small"
        type="text"
        icon={icon}
        disabled={disabled}
        aria-label={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        {icon ? null : title}
      </Button>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------
// 独立窗口编辑器主体
// ---------------------------------------------------------------------------

/** 独立窗口内的富文本编辑器：可视化 / 源码 / 预览，完整工具栏，Markdown 落盘 */
export default function RichTextEditor({
  title,
  value,
  standardId,
  placeholder,
  onCancel,
  onSave
}: RichTextEditorProps) {
  const { message, modal } = AntdApp.useApp()
  const [mode, setMode] = useState<Mode>('visual')
  const [source, setSource] = useState(value)
  const [htmlVersion, setHtmlVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [linkText, setLinkText] = useState('')
  const [linkUrl, setLinkUrl] = useState('https://')
  const [tex, setTex] = useState('')
  const [texDisplay, setTexDisplay] = useState(false)
  const [rows, setRows] = useState(3)
  const [cols, setCols] = useState(3)

  const editorRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<TextAreaRef | null>(null)
  const getTa = (): HTMLTextAreaElement | null =>
    (taRef.current?.nativeElement as HTMLTextAreaElement | null) ?? null
  const savedRange = useRef<Range | null>(null)
  const sourceRef = useRef(value)
  const modeRef = useRef<Mode>('visual')
  const initialRef = useRef(value)
  const visualEditedRef = useRef(false)

  const updateSource = (v: string): void => {
    sourceRef.current = v
    setSource(v)
  }

  /** 组件挂载（每次编辑会话由 key 强制重新挂载）时初始化内容 */
  useEffect(() => {
    initialRef.current = value
    sourceRef.current = value
    setSource(value)
    modeRef.current = 'visual'
    setMode('visual')
    visualEditedRef.current = false
    setDialog(null)
    setLinkText('')
    setLinkUrl('https://')
    setTex('')
    setRows(3)
    setCols(3)
    setHtmlVersion((v) => v + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 进入可视化模式时，把当前 Markdown 渲染为可编辑 DOM；编辑过程中不重置，保证光标稳定 */
  useEffect(() => {
    if (modeRef.current !== 'visual') return
    let cancelled = false
    let tries = 0
    const apply = (): void => {
      if (cancelled || visualEditedRef.current) return
      const el = editorRef.current
      // 切换到可视化模式时 DOM 可能晚一帧挂载：短暂重试，避免初次打开空白
      if (!el) {
        if (tries++ < 20) window.setTimeout(apply, 25)
        return
      }
      el.innerHTML = markdownToHtml(sourceRef.current)
      enhanceEditorDom(el)
      savedRange.current = null
    }
    apply()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [htmlVersion])

  const captureSelection = (): void => {
    const sel = window.getSelection()
    if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange()
    }
  }

  const restoreSelection = (): void => {
    const sel = window.getSelection()
    const range = savedRange.current
    if (sel && range && editorRef.current?.contains(range.commonAncestorContainer)) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  const syncFromDom = (): void => {
    if (!editorRef.current) return
    updateSource(htmlToMarkdown(editorRef.current.innerHTML))
  }

  const exec = (cmd: string, arg?: string): void => {
    const el = editorRef.current
    if (!el) return
    el.focus()
    restoreSelection()
    document.execCommand('styleWithCSS', false, 'false')
    document.execCommand(cmd, false, arg)
    visualEditedRef.current = true
    syncFromDom()
    captureSelection()
  }

  const sourceInsert = (text: string): void => {
    const ta = getTa()
    const cur = sourceRef.current
    const start = ta?.selectionStart ?? cur.length
    const end = ta?.selectionEnd ?? cur.length
    updateSource(cur.slice(0, start) + text + cur.slice(end))
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(start + text.length, start + text.length)
    })
  }

  const sourceWrap = (before: string, after: string, placeholderText: string): void => {
    const ta = getTa()
    const cur = sourceRef.current
    const start = ta?.selectionStart ?? cur.length
    const end = ta?.selectionEnd ?? cur.length
    const picked = cur.slice(start, end)
    const inner = picked || placeholderText
    updateSource(cur.slice(0, start) + before + inner + after + cur.slice(end))
    requestAnimationFrame(() => {
      ta?.focus()
      if (picked) ta?.setSelectionRange(start, start + before.length + inner.length + after.length)
      else ta?.setSelectionRange(start + before.length, start + before.length + inner.length)
    })
  }

  const sourcePrefixLines = (prefix: string): void => {
    const ta = getTa()
    const cur = sourceRef.current
    const start = ta?.selectionStart ?? 0
    const end = ta?.selectionEnd ?? 0
    const lineStart = cur.lastIndexOf('\n', Math.max(0, start - 1)) + 1
    const foundEnd = cur.indexOf('\n', end)
    const lineEnd = foundEnd < 0 ? cur.length : foundEnd
    const block = cur.slice(lineStart, lineEnd)
    const out = block
      .split('\n')
      .map((l) => prefix + l.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+|- \[[ xX]\]\s+)/, ''))
      .join('\n')
    updateSource(cur.slice(0, lineStart) + out + cur.slice(lineEnd))
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(lineStart, lineStart + out.length)
    })
  }

  /** 在当前光标处插入一段 Markdown（可视化模式自动转 HTML） */
  const insertMarkdown = (block: string): void => {
    if (modeRef.current === 'visual') {
      exec('insertHTML', markdownToHtml(block) + '<p><br></p>')
      enhanceEditorDom(editorRef.current)
    } else {
      sourceInsert(block)
    }
  }

  const runVisual = (a: Action): void => {
    switch (a) {
      case 'undo': exec('undo'); break
      case 'redo': exec('redo'); break
      case 'p': exec('formatBlock', 'p'); break
      case 'h1': exec('formatBlock', 'h1'); break
      case 'h2': exec('formatBlock', 'h2'); break
      case 'h3': exec('formatBlock', 'h3'); break
      case 'bold': exec('bold'); break
      case 'italic': exec('italic'); break
      case 'strike': exec('strikeThrough'); break
      case 'clear': exec('removeFormat'); break
      case 'ul': exec('insertUnorderedList'); break
      case 'ol': exec('insertOrderedList'); break
      case 'task':
        exec('insertHTML', '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox"> 待办事项</li></ul><p><br></p>')
        break
      case 'quote': exec('formatBlock', 'blockquote'); break
      case 'code': exec('insertHTML', `<code>${escapeHtml(window.getSelection()?.toString() || '代码')}</code>`); break
      case 'codeblock':
        exec('insertHTML', `<pre><code>${escapeHtml(window.getSelection()?.toString() || '// 代码')}</code></pre><p><br></p>`)
        break
      case 'hr': exec('insertHorizontalRule'); break
      default: break
    }
  }

  const runSource = (a: Action): void => {
    switch (a) {
      case 'undo': document.execCommand('undo'); break
      case 'redo': document.execCommand('redo'); break
      case 'p': sourcePrefixLines(''); break
      case 'h1': sourcePrefixLines('# '); break
      case 'h2': sourcePrefixLines('## '); break
      case 'h3': sourcePrefixLines('### '); break
      case 'bold': sourceWrap('**', '**', '加粗文字'); break
      case 'italic': sourceWrap('*', '*', '斜体文字'); break
      case 'strike': sourceWrap('~~', '~~', '删除线'); break
      case 'clear': {
        const ta = getTa()
        const cur = sourceRef.current
        const start = ta?.selectionStart ?? 0
        const end = ta?.selectionEnd ?? 0
        const cleaned = cur.slice(start, end).replace(/[*_~`]/g, '')
        updateSource(cur.slice(0, start) + cleaned + cur.slice(end))
        break
      }
      case 'ul': sourcePrefixLines('- '); break
      case 'ol': sourcePrefixLines('1. '); break
      case 'task': sourcePrefixLines('- [ ] '); break
      case 'quote': sourcePrefixLines('> '); break
      case 'code': sourceWrap('`', '`', '代码'); break
      case 'codeblock': sourceWrap('\n```\n', '\n```\n', '代码内容'); break
      case 'hr': sourceInsert('\n\n---\n\n'); break
      default: break
    }
  }

  const run = (a: Action): void => {
    if (a === 'link' || a === 'formula' || a === 'table') {
      setDialog(a)
      return
    }
    if (a === 'image') {
      void importImage()
      return
    }
    if (modeRef.current === 'preview') {
      switchMode('visual')
      window.setTimeout(() => run(a), 0)
      return
    }
    if (modeRef.current === 'source') runSource(a)
    else runVisual(a)
  }

  const switchMode = (next: Mode): void => {
    if (modeRef.current === 'visual' && visualEditedRef.current && editorRef.current) {
      updateSource(htmlToMarkdown(editorRef.current.innerHTML))
    }
    modeRef.current = next
    if (next === 'visual') {
      visualEditedRef.current = false
      setHtmlVersion((v) => v + 1)
    }
    setMode(next)
  }

  // ---- 图片：AI 识别（只插文字）/ 仅粘贴图片 ----
  /**
   * mode='ocr'：AI 转写为文字后**只插入识别结果**，内容末尾不再附截图；
   *   识别失败或返回空时退回插入原图兜底，避免内容丢失，并给出提示。
   * mode='image'：保存并只插入原图。
   */
  const handleImageData = async (dataUrl: string, label: string, mode: 'ocr' | 'image'): Promise<void> => {
    if (busy) return
    setBusy(true)
    void message.open({ key: 'rteImg', type: 'loading', content: mode === 'ocr' ? '正在识别截图…' : '正在保存图片…', duration: 0 })
    try {
      if (mode === 'ocr') {
        let ocr = ''
        let ocrError = ''
        try {
          ocr = unwrap<string>(await window.api.imageToMarkdown(dataUrl))
        } catch (err) {
          ocrError = err instanceof Error ? err.message : String(err)
        }
        const text = ocr.trim()
        if (text) {
          // 识别成功：只写入文字，不保存也不插入原图
          insertMarkdown(text)
          void message.open({ key: 'rteImg', type: 'success', content: '截图已识别为文字并插入', duration: 2 })
          return
        }
        // 识别失败 / 无文字：退回插入原图兜底，避免截图内容完全丢失
        const rel = unwrap<string>(await window.api.saveStandardImage(dataUrl))
        insertMarkdown(`![${label}](stdimg://local/${rel})`)
        void message.open({
          key: 'rteImg',
          type: 'warning',
          content: ocrError
            ? `文字识别失败，已改为插入原图：${ocrError}`
            : '未识别到文字，已改为插入原图；如只需图片请选择「仅粘贴图片」',
          duration: 6
        })
        return
      }
      const rel = unwrap<string>(await window.api.saveStandardImage(dataUrl))
      insertMarkdown(`![${label}](stdimg://local/${rel})`)
      void message.open({ key: 'rteImg', type: 'success', content: '已粘贴图片', duration: 2 })
    } catch (err) {
      void message.open({ key: 'rteImg', type: 'error', content: err instanceof Error ? err.message : String(err), duration: 3 })
    } finally {
      setBusy(false)
    }
  }

  const importImage = async (): Promise<void> => {
    setBusy(true)
    try {
      const paths = unwrap<string[]>(await window.api.addStandardImage(standardId))
      for (const rel of paths) {
        insertMarkdown(`![图片](stdimg://local/${rel})`)
      }
      if (paths.length) void message.success(`已插入 ${paths.length} 张图片`)
    } catch (err) {
      void message.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 右键「粘贴文本」：把纯文本直接插到当前光标处 */
  const insertPlainText = (text: string): void => {
    if (modeRef.current === 'source') {
      sourceInsert(text)
      return
    }
    const el = editorRef.current
    if (!el) return
    el.focus()
    restoreSelection()
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) {
      // 右键发生在工具栏等非编辑区时，光标落到文末
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    document.execCommand('insertText', false, text)
    visualEditedRef.current = true
    syncFromDom()
    captureSelection()
  }

  // 右键菜单粘贴：文本直粘；截图按用户选择「仅粘贴图片」或「AI 识别并粘贴」
  const pasteHandlerRef = useRef<(p: RichTextPastePayload) => void>(() => {})
  pasteHandlerRef.current = (p) => {
    if (modeRef.current === 'preview') {
      switchMode('visual')
      window.setTimeout(() => pasteHandlerRef.current(p), 0)
      return
    }
    if (p.kind === 'text') insertPlainText(p.text)
    else if (p.kind === 'image') void handleImageData(p.dataUrl, '粘贴截图', 'image')
    else void handleImageData(p.dataUrl, '粘贴截图', 'ocr')
  }
  useEffect(() => window.api.onRichTextPaste((p) => pasteHandlerRef.current(p)), [])

  // 编辑窗口内任意位置 Ctrl+V 粘贴截图：AI 识别为文字后只插入文字，不再附原图
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => void handleImageData(String(reader.result), '粘贴截图', 'ocr')
      reader.readAsDataURL(file)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })

  // 拖拽本地图片到编辑区
  const onDropFile = (e: DragEvent): void => {
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    const reader = new FileReader()
    // 拖入的是图片文件，直接插入原图（不做 AI 识别）
    reader.onload = () => void handleImageData(String(reader.result), '拖入图片', 'image')
    reader.readAsDataURL(file)
  }

  // ---- 插入对话框 ----
  const insertLink = (): void => {
    const text = linkText.trim() || linkUrl.trim()
    const url = linkUrl.trim()
    if (!url) return
    if (modeRef.current === 'visual') {
      if (window.getSelection()?.toString()) exec('createLink', url)
      else exec('insertHTML', `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`)
    } else {
      sourceInsert(`[${text}](${url})`)
    }
    setDialog(null)
  }

  const insertFormula = (): void => {
    const t = tex.trim()
    if (!t) return
    if (modeRef.current === 'visual') {
      const html = `<span class="rte-math" data-tex="${escapeHtml(t)}" data-display="${texDisplay}" contenteditable="false">${katexRender(t, { throwOnError: false, displayMode: texDisplay })}</span>`
      exec('insertHTML', `${html}<p><br></p>`)
      enhanceEditorDom(editorRef.current)
    } else {
      sourceInsert(texDisplay ? `\n\n$$\n${t}\n$$\n\n` : `$${t}$`)
    }
    setDialog(null)
  }

  const insertTable = (): void => {
    const r = Math.min(Math.max(rows, 1), 12)
    const c = Math.min(Math.max(cols, 1), 8)
    if (modeRef.current === 'visual') exec('insertHTML', tableHtml(r, c))
    else sourceInsert(`\n\n${tableMarkdown(r, c)}\n\n`)
    setDialog(null)
  }

  // ---- 快捷键 ----
  const onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      doSave()
      return
    }
    if (!mod) return
    const k = e.key.toLowerCase()
    if (k === 'b') { e.preventDefault(); run('bold') }
    else if (k === 'i') { e.preventDefault(); run('italic') }
    else if (k === 'k') { e.preventDefault(); setDialog('link') }
    else if (k === 'e') { e.preventDefault(); run('code') }
    else if (e.shiftKey && e.code === 'Digit7') { e.preventDefault(); run('ol') }
    else if (e.shiftKey && e.code === 'Digit8') { e.preventDefault(); run('ul') }
  }

  const onSourceKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Tab') {
      e.preventDefault()
      sourceInsert('  ')
      return
    }
    if (e.key === 'Enter') {
      const ta = e.currentTarget
      const cur = sourceRef.current
      const pos = ta.selectionStart
      const lineStart = cur.lastIndexOf('\n', pos - 1) + 1
      const line = cur.slice(lineStart, pos)
      const m = line.match(/^(\s*)(?:(\d+)\. |- \[[ xX]\] |[-*+] )/)
      if (m) {
        e.preventDefault()
        const marker = m[2] ? `${Number(m[2]) + 1}. ` : line.includes('- [') ? '- [ ] ' : m[0].slice(m[1].length)
        sourceInsert(`\n${m[1]}${marker}`)
      }
    }
    // 其余快捷键（Ctrl+S / Ctrl+B / …）由外层 onKeyDown 冒泡统一处理
  }

  const doSave = (): void => {
    let final = sourceRef.current
    if (modeRef.current === 'visual' && visualEditedRef.current && editorRef.current) {
      final = htmlToMarkdown(editorRef.current.innerHTML)
      updateSource(final)
    }
    onSave(final)
  }

  const doCancel = (): void => {
    if (sourceRef.current !== initialRef.current) {
      modal.confirm({
        title: '放弃未保存的修改？',
        content: '本次在富文本编辑器中的修改尚未保存，关闭后将丢失。',
        okText: '放弃修改',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: onCancel
      })
    } else {
      onCancel()
    }
  }

  const charCount = source.replace(/\s/g, '').length
  const changed = source !== initialRef.current
  const modeLabel = mode === 'visual' ? '可视化编辑' : mode === 'source' ? 'Markdown 源码' : '渲染预览'
  const modeColor = mode === 'visual' ? 'blue' : mode === 'source' ? 'purple' : 'green'

  const headingItems = [
    { key: 'p', label: '正文' },
    { key: 'h1', label: '一级标题 H1' },
    { key: 'h2', label: '二级标题 H2' },
    { key: 'h3', label: '三级标题 H3' }
  ].map((i) => ({ key: i.key, label: <a onClick={() => run(i.key as Action)}>{i.label}</a> }))

  const toolbar = (
    <div className="rte-toolbar">
      <TBtn icon={<UndoOutlined />} title="撤销 (Ctrl+Z)" onClick={() => run('undo')} />
      <TBtn icon={<RedoOutlined />} title="重做 (Ctrl+Y)" onClick={() => run('redo')} />
      <span className="rte-sep" />
      <Dropdown menu={{ items: headingItems }} trigger={['click']} placement="bottomLeft">
        <Button size="small" type="text" onMouseDown={(e) => e.preventDefault()}>
          标题 <span className="rte-caret">▾</span>
        </Button>
      </Dropdown>
      <TBtn icon={<BoldOutlined />} title="加粗 (Ctrl+B)" onClick={() => run('bold')} />
      <TBtn icon={<ItalicOutlined />} title="斜体 (Ctrl+I)" onClick={() => run('italic')} />
      <TBtn icon={<StrikethroughOutlined />} title="删除线" onClick={() => run('strike')} />
      <TBtn icon={<ClearOutlined />} title="清除格式" onClick={() => run('clear')} />
      <span className="rte-sep" />
      <TBtn icon={<UnorderedListOutlined />} title="无序列表 (Ctrl+Shift+8)" onClick={() => run('ul')} />
      <TBtn icon={<OrderedListOutlined />} title="有序列表 (Ctrl+Shift+7)" onClick={() => run('ol')} />
      <TBtn icon={<CheckSquareOutlined />} title="任务列表" onClick={() => run('task')} />
      <TBtn icon={<BlockOutlined />} title="引用" onClick={() => run('quote')} />
      <TBtn icon={<CodeOutlined />} title="行内代码 (Ctrl+E)" onClick={() => run('code')} />
      <TBtn icon={<AimOutlined />} title="代码块" onClick={() => run('codeblock')} />
      <span className="rte-sep" />
      <TBtn icon={<TableOutlined />} title="插入表格" onClick={() => run('table')} />
      <TBtn icon={<LinkOutlined />} title="插入链接 (Ctrl+K)" onClick={() => run('link')} />
      <TBtn icon={<FunctionOutlined />} title="插入 LaTeX 公式" onClick={() => run('formula')} />
      <TBtn icon={<LineOutlined />} title="分割线" onClick={() => run('hr')} />
      <TBtn icon={<PictureOutlined />} title="导入本地图片" onClick={() => run('image')} disabled={busy} />
    </div>
  )

  return (
    <div className="rte-window" onKeyDown={onKeyDown}>
      <div className="rte-window-header">
        <div className="rte-window-title">
          <EditOutlined />
          <span>{title}</span>
          <Tag color={modeColor} style={{ marginInlineEnd: 0 }}>{modeLabel}</Tag>
          {changed && <Tag color="orange" style={{ marginInlineEnd: 0 }}>未保存</Tag>}
        </div>
        <Button type="text" icon={<CloseOutlined />} aria-label="关闭编辑器" onClick={doCancel} />
      </div>

      <div className="rte-window-body">
        <div className="rte-topbar">
          {toolbar}
          <Segmented
            size="small"
            value={mode}
            onChange={(v) => switchMode(v as Mode)}
            options={[
              { label: '可视化', value: 'visual', icon: <EditOutlined /> },
              { label: '源码', value: 'source', icon: <CodeOutlined /> },
              { label: '预览', value: 'preview', icon: <EyeOutlined /> }
            ]}
          />
        </div>

        <div className="rte-stage" onDrop={onDropFile} onDragOver={(e) => e.preventDefault()}>
          {mode === 'visual' && (
            <div
              ref={editorRef}
              className="rte-surface"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              data-placeholder={placeholder ?? '在此输入内容，或从工具栏插入表格、公式与图片…'}
              onInput={() => {
                visualEditedRef.current = true
                syncFromDom()
                captureSelection()
              }}
              onKeyUp={captureSelection}
              onMouseUp={captureSelection}
              onBlur={captureSelection}
            />
          )}
          {mode === 'source' && (
            <div className="rte-source-wrap">
              <Input.TextArea
                ref={taRef}
                className="rte-source"
                value={source}
                onChange={(e) => updateSource(e.target.value)}
                onKeyDown={onSourceKeyDown}
                onBlur={captureSelection}
                placeholder={placeholder ?? '支持 Markdown / LaTeX；表格、公式、图片可从工具栏插入'}
                spellCheck={false}
              />
              <div className="rte-live-preview">
                <div className="rte-live-label">实时预览</div>
                <Markdown text={source} />
              </div>
            </div>
          )}
          {mode === 'preview' && (
            <div className="rte-preview">
              <Markdown text={source} />
            </div>
          )}
        </div>
      </div>

      <div className="rte-footer">
        <Space size={8} wrap>
          <Text type="secondary" style={{ fontSize: 12 }}>{charCount} 字</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            Ctrl+S 保存 · 右键粘贴文本 / 截图（AI 识别仅插入文字）· Ctrl+V 截图识别为文字
          </Text>
        </Space>
        <Space size={8}>
          <Button onClick={doCancel}>取消</Button>
          <Button type="primary" onClick={doSave}>保存</Button>
        </Space>
      </div>

      {/* 插入链接 */}
      <Modal
        open={dialog === 'link'}
        title="插入链接"
        width={420}
        onCancel={() => setDialog(null)}
        onOk={insertLink}
        okText="插入"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <div><Text style={{ fontSize: 12 }}>显示文字</Text><Input value={linkText} onChange={(e) => setLinkText(e.target.value)} placeholder="留空则使用链接地址" /></div>
          <div><Text style={{ fontSize: 12 }}>链接地址</Text><Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…" /></div>
        </Space>
      </Modal>

      {/* 插入公式 */}
      <Modal
        open={dialog === 'formula'}
        title="插入 LaTeX 公式"
        width={520}
        onCancel={() => setDialog(null)}
        onOk={insertFormula}
        okText="插入"
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Radio.Group value={texDisplay ? 'display' : 'inline'} onChange={(e) => setTexDisplay(e.target.value === 'display')}>
            <Radio.Button value="inline">行内公式 $...$</Radio.Button>
            <Radio.Button value="display">独立公式 $$...$$</Radio.Button>
          </Radio.Group>
          <Input.TextArea
            value={tex}
            onChange={(e) => setTex(e.target.value)}
            rows={4}
            placeholder="例：\frac{-b \pm \sqrt{b^2-4ac}}{2a}"
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {String.raw`常用：\frac{a}{b} · x^{2} · \sqrt{x} · \int_0^1 x\,dx · \sum_{i=1}^{n} i`}
          </Text>
          {tex.trim() && <div className="rte-formula-preview"><Markdown text={texDisplay ? `$$\n${tex}\n$$` : `$${tex}$`} /></div>}
        </Space>
      </Modal>

      {/* 插入表格 */}
      <Modal
        open={dialog === 'table'}
        title="插入表格"
        width={380}
        onCancel={() => setDialog(null)}
        onOk={insertTable}
        okText="插入"
        cancelText="取消"
        destroyOnClose
      >
        <Space size={12} align="center">
          <div><Text style={{ fontSize: 12 }}>行数</Text><InputNumber min={1} max={12} value={rows} onChange={(v) => setRows(Number(v) || 1)} /></div>
          <div><Text style={{ fontSize: 12 }}>列数</Text><InputNumber min={1} max={8} value={cols} onChange={(v) => setCols(Number(v) || 1)} /></div>
        </Space>
      </Modal>
    </div>
  )
}
