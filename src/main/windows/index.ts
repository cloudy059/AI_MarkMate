import { BrowserWindow, app, screen } from 'electron'
import path from 'node:path'
import { IPC, type AdjustBox, type GradingEvent, type Rect, type Region, type RegionKind } from '@shared/types'
import { configStore } from '@main/services/config-store'
import { automation } from '@main/services/automation'

// ============================================================
// 窗口管理：侧边栏（含设置视图）/ 全屏标记 Overlay
// ============================================================

let sidebarWindow: BrowserWindow | null = null
let overlayWindows: BrowserWindow[] = []

/** Windows 下窗口图标（resources/icon.ico） */
function winIcon(): string | undefined {
  return process.platform === 'win32'
    ? path.join(app.getAppPath(), 'resources', 'icon.ico')
    : undefined
}

interface MarkSession {
  resolve: (r: Region | null) => void
  kind: RegionKind
  id?: string
  label: string
}
let markSession: MarkSession | null = null

interface AdjustSession {
  resolve: (r: Record<string, Rect> | null) => void
  boxes: AdjustBox[]
}
let adjustSession: AdjustSession | null = null

function preloadPath(): string {
  return path.join(__dirname, '../preload/index.js')
}

function webPrefs(): Electron.WebPreferences {
  return {
    preload: preloadPath(),
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false
  }
}

export function loadRenderer(win: BrowserWindow, name: string, opts: { search?: string; hash?: string } = {}): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const search = opts.search ? (opts.search.startsWith('?') ? opts.search : `?${opts.search}`) : ''
  if (devUrl) {
    win.loadURL(`${devUrl}/${name}/index.html${search}${opts.hash ?? ''}`)
  } else {
    win.loadFile(path.join(__dirname, `../renderer/${name}/index.html`), {
      ...(search ? { search: search.slice(1) } : {}),
      ...(opts.hash ? { hash: opts.hash.slice(1) } : {})
    })
  }
}

// ---------------- 侧边栏 ----------------
export function createSidebar(): BrowserWindow {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) return sidebarWindow
  const cfg = configStore.get()
  const primary = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    width: 360,
    height: 700,
    minWidth: 300,
    minHeight: 420,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    icon: winIcon(),
    webPreferences: webPrefs()
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  const pos = cfg.settings.sidebarPos
  if (pos) win.setPosition(Math.round(pos.x), Math.round(pos.y))
  else win.setPosition(primary.workArea.x + primary.workArea.width - 380, primary.workArea.y + 80)
  loadRenderer(win, 'sidebar')

  let saveTimer: NodeJS.Timeout | null = null
  win.on('moved', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        const [x, y] = win.getPosition()
        configStore.patch({ settings: { sidebarPos: { x, y } } })
      } catch {
        /* ignore */
      }
    }, 600)
  })
  win.on('closed', () => {
    sidebarWindow = null
  })
  if (cfg.settings.sidebarHidden) win.hide()
  else win.show()
  sidebarWindow = win
  return win
}

export function toggleSidebar(force?: 'show' | 'hide'): void {
  if (!sidebarWindow || sidebarWindow.isDestroyed()) {
    createSidebar()
    configStore.patch({ settings: { sidebarHidden: false } })
    return
  }
  const show = force ? force === 'show' : !sidebarWindow.isVisible()
  if (show) {
    sidebarWindow.show()
    sidebarWindow.focus()
  } else sidebarWindow.hide()
  configStore.patch({ settings: { sidebarHidden: !show } })
}

// ---------------- 打开设置（集成在侧边栏内） ----------------

/**
 * 唤起侧边栏并切换到设置视图。
 * page 为空时进入设置菜单；传具体 key（如 'providers'）直达对应设置页。
 */
export function openSettings(page?: string): void {
  let win = sidebarWindow
  if (!win || win.isDestroyed()) win = createSidebar()
  const target = win
  if (!target.isVisible()) target.show()
  target.focus()
  const send = () => {
    if (!target.isDestroyed()) target.webContents.send(IPC.SettingsNavigate, page ?? '')
  }
  // 新建窗口时页面尚未加载完成，等 load 结束再发导航事件
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', send)
  else send()
}

// ---------------- 标记 Overlay ----------------
const KIND_LABEL: Record<RegionKind, string> = {
  answer: '答题区域',
  score: '分值输入框',
  submit: '提交按钮'
}

export function markRegion(target: { kind: RegionKind; id?: string; label?: string }): Promise<Region | null> {
  if (markSession || adjustSession) return Promise.resolve(null)
  return new Promise((resolve) => {
    markSession = {
      resolve,
      kind: target.kind,
      id: target.id,
      label: target.label ?? KIND_LABEL[target.kind]
    }
    overlayWindows = screen.getAllDisplays().map((d) => createOverlayWindow(d))
  })
}

/** 屏幕定位框手动调整：在元素上显示定位框，拖动/调整大小后确认；取消返回 null */
export function adjustRegionBoxes(boxes: AdjustBox[]): Promise<Record<string, Rect> | null> {
  if (markSession || adjustSession) return Promise.resolve(null)
  return new Promise((resolve) => {
    adjustSession = { resolve, boxes }
    // 仅在包含定位框的显示器上创建调整层
    const displays = screen.getAllDisplays().filter((d) =>
      boxes.some(
        (b) =>
          b.rect.x < d.bounds.x + d.bounds.width &&
          b.rect.x + b.rect.w > d.bounds.x &&
          b.rect.y < d.bounds.y + d.bounds.height &&
          b.rect.y + b.rect.h > d.bounds.y
      )
    )
    overlayWindows = (displays.length ? displays : screen.getAllDisplays()).map((d) => createOverlayWindow(d))
  })
}

function createOverlayWindow(display: Electron.Display): BrowserWindow {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    focusable: true,
    webPreferences: webPrefs()
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (adjustSession) {
    // 调整模式：传入框数据（全局 DIP 坐标，渲染层自行换算为本窗口局部坐标）
    loadRenderer(win, 'overlay', { search: 'kind=adjust' })
    const sendInit = () => {
      if (adjustSession && !win.isDestroyed()) {
        win.webContents.send(IPC.OverlayInit, { bounds: display.bounds, boxes: adjustSession.boxes })
      }
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', sendInit)
    else sendInit()
  } else {
    const label = encodeURIComponent(markSession?.label ?? '')
    loadRenderer(win, 'overlay', { search: `kind=${markSession?.kind ?? 'answer'}&label=${label}` })
  }
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.on('closed', () => {
    overlayWindows = overlayWindows.filter((w) => w !== win)
  })
  return win
}

function closeOverlays(): void {
  for (const w of overlayWindows) {
    try {
      w.destroy()
    } catch {
      /* ignore */
    }
  }
  overlayWindows = []
}

export async function handleOverlaySubmit(
  sender: BrowserWindow,
  payload: { rect?: Rect; point?: { x: number; y: number } }
): Promise<void> {
  const session = markSession
  if (!session) return
  const bounds = sender.getBounds()
  const display = screen.getDisplayMatching(bounds)
  let rect: Rect | null = null
  let phys: { x: number; y: number } | undefined
  if (payload.point) {
    const gx = bounds.x + payload.point.x
    const gy = bounds.y + payload.point.y
    rect = { x: gx - 12, y: gy - 12, w: 24, h: 24 }
    if (automation.getStatus().ok) {
      try {
        phys = await automation.getMousePos()
      } catch {
        phys = undefined
      }
    }
  } else if (payload.rect) {
    rect = {
      x: bounds.x + payload.rect.x,
      y: bounds.y + payload.rect.y,
      w: Math.max(payload.rect.w, 4),
      h: Math.max(payload.rect.h, 4)
    }
  }
  closeOverlays()
  if (!rect) {
    markSession = null
    session.resolve(null)
    return
  }
  const region: Region = {
    id: session.id ?? session.kind,
    kind: session.kind,
    label: session.label,
    displayId: display.id,
    rect,
    scaleAtMark: display.scaleFactor,
    ...(phys ? { phys } : {})
  }
  markSession = null
  session.resolve(region)
}

/** 调整层确认：窗口局部坐标 → 全局 DIP 坐标后回调 */
export function handleOverlayAdjustSubmit(sender: BrowserWindow, map: Record<string, Rect>): void {
  const session = adjustSession
  if (!session) return
  const bounds = sender.getBounds()
  const out: Record<string, Rect> = {}
  for (const [key, r] of Object.entries(map)) {
    out[key] = { x: bounds.x + r.x, y: bounds.y + r.y, w: Math.max(r.w, 4), h: Math.max(r.h, 4) }
  }
  adjustSession = null
  closeOverlays()
  session.resolve(out)
}

export function handleOverlayCancel(): void {
  const session = markSession
  const adjust = adjustSession
  markSession = null
  adjustSession = null
  closeOverlays()
  session?.resolve(null)
  adjust?.resolve(null)
}

// ---------------- 事件广播 ----------------
export function broadcastGradingEvent(e: GradingEvent): void {
  if (sidebarWindow && !sidebarWindow.isDestroyed()) {
    sidebarWindow.webContents.send(IPC.GradingEvent, e)
  }
}

export function getSidebarWindow(): BrowserWindow | null {
  return sidebarWindow
}
