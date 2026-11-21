import { BrowserWindow, Menu, clipboard, type WebContents } from 'electron'
import { IPC, type RichTextPastePayload } from '@shared/types'

/**
 * 读取系统剪贴板中的图片并转成 dataURL。
 * Electron 44 已移除 clipboard.readImage，改用 W3C 风格 read() → ClipboardItem。
 */
async function readClipboardImage(): Promise<string | null> {
  const items = await clipboard.read()
  for (const it of items) {
    const imgType = it.types.find((t) => t.startsWith('image/'))
    if (!imgType) continue
    try {
      const payload = await it.getType(imgType)
      if (!('arrayBuffer' in payload)) continue
      const buf = Buffer.from(await payload.arrayBuffer())
      if (!buf.length) continue
      return `data:${imgType};base64,${buf.toString('base64')}`
    } catch {
      /* 该项不含图片，继续检查下一项 */
    }
  }
  return null
}

/**
 * 独立富文本编辑窗口的右键菜单：
 * - 纯文本剪贴板：交给系统默认粘贴（保留富文本格式）
 * - 含截图：提供「仅粘贴图片」与「AI 识别截图并粘贴」两种选择，也可只粘贴文本
 *   （AI 识别只插入转写后的文字，不在末尾附原图；识别失败时才回退插入原图）
 * - 其余为常规编辑项
 */
export function attachRichTextContextMenu(win: BrowserWindow): void {
  const wc: WebContents = win.webContents
  wc.on('context-menu', (event, params) => {
    event.preventDefault()
    void (async () => {
      let text = ''
      let image: string | null = null
      try {
        text = await clipboard.readText()
      } catch {
        /* 剪贴板不可读时忽略 */
      }
      try {
        image = await readClipboardImage()
      } catch {
        /* 剪贴板不可读时忽略 */
      }
      if (wc.isDestroyed()) return

      const send = (p: RichTextPastePayload): void => {
        if (!wc.isDestroyed()) wc.send(IPC.RichTextPaste, p)
      }
      const items: Electron.MenuItemConstructorOptions[] = []

      if (text.trim()) {
        // 无图片时走系统默认粘贴，可保留复制来源的富文本格式
        items.push(
          image
            ? { label: '粘贴文本', click: () => send({ kind: 'text', text }) }
            : { label: '粘贴', role: 'paste' }
        )
      }
      if (image) {
        items.push({
          label: '仅粘贴图片',
          click: () => send({ kind: 'image', dataUrl: image as string })
        })
        items.push({
          label: 'AI 识别截图并粘贴（仅文字）',
          click: () => send({ kind: 'ocr', dataUrl: image as string })
        })
      }
      if (!items.length) items.push({ label: '剪贴板为空', enabled: false })

      items.push({ type: 'separator' })
      const editable = params.isEditable
      const hasSelection = Boolean(params.selectionText)
      items.push(
        { label: '撤销', role: 'undo', enabled: editable },
        { label: '重做', role: 'redo', enabled: editable },
        { type: 'separator' },
        { label: '剪切', role: 'cut', enabled: editable && hasSelection },
        { label: '复制', role: 'copy', enabled: hasSelection },
        { label: '删除', role: 'delete', enabled: editable && hasSelection },
        { type: 'separator' },
        { label: '全选', role: 'selectAll', enabled: editable }
      )

      const owner = BrowserWindow.fromWebContents(wc)
      Menu.buildFromTemplate(items).popup(owner ? { window: owner } : {})
    })()
  })
}
