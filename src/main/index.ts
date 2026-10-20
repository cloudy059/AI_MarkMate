import { Menu, Tray, app, nativeImage, net, protocol, systemPreferences, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { configStore } from '@main/services/config-store'
import { logger } from '@main/services/logger'
import { automation } from '@main/services/automation'
import { lanBalancer } from '@main/ai/lan-balancer'
import { gradingEngine } from '@main/grading/state-machine'
import {
  broadcastGradingEvent,
  createSidebar,
  openSettings,
  toggleSidebar
} from '@main/windows'
import { registerIpc } from '@main/ipc'
import { applyHotkey } from '@main/hotkey'

// 单实例锁
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// stdimg:// 自定义协议：渲染评分标准 Markdown 中嵌入的本地图片（须在 app ready 前注册）
protocol.registerSchemesAsPrivileged([{ scheme: 'stdimg', privileges: { standard: true, secure: true } }])

let tray: Tray | null = null

function trayIcon(): Electron.NativeImage {
  const p = path.join(app.getAppPath(), 'resources', 'tray.png')
  try {
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return process.platform === 'darwin' ? img.resize({ width: 16, height: 16 }) : img
    }
  } catch {
    /* ignore */
  }
  return nativeImage.createFromDataURL(FALLBACK_TRAY_ICON)
}

function createTray(): void {
  try {
    tray = new Tray(trayIcon())
    // 双击托盘图标：呼出侧边栏（隐藏时显示，已显示时置顶聚焦）
    tray.on('double-click', () => toggleSidebar('show'))
    rebuildTrayMenu()
  } catch (err) {
    logger.error({ phase: 'app', error: `托盘创建失败：${err instanceof Error ? err.message : String(err)}` })
  }
}

function rebuildTrayMenu(): void {
  if (!tray) return
  const running = gradingEngine.getState() !== 'idle'
  const menu: MenuItemConstructorOptions[] = [
    { label: running ? '停止批改' : '开始批改', click: () => gradingEngine.control(running ? 'stop' : 'start') },
    { type: 'separator' },
    { label: '显示 / 隐藏侧边栏', click: () => toggleSidebar() },
    { label: '打开设置', click: () => openSettings() },
    { type: 'separator' },
    { label: '退出', click: () => {
      configStore.saveNow()
      app.quit()
    } }
  ]
  tray.setContextMenu(Menu.buildFromTemplate(menu))
  tray.setToolTip('AI自动阅卷助手')
}

app.whenReady().then(() => {
  configStore.init()
  logger.init()
  logger.info({ phase: 'app', detail: `应用启动 v${app.getVersion()} (${process.platform})` })

  // stdimg://local/<相对路径> → userData/standards 下的图片（评分标准嵌入图预览）
  protocol.handle('stdimg', (req) => {
    try {
      const u = new URL(req.url)
      const rel = decodeURIComponent(u.pathname.replace(/^\//, ''))
      const root = path.join(app.getPath('userData'), 'standards')
      const full = path.normalize(path.join(root, rel))
      if (!full.startsWith(root)) return new Response('forbidden', { status: 403 })
      if (!fs.existsSync(full)) return new Response('not found', { status: 404 })
      return net.fetch(pathToFileURL(full).toString())
    } catch {
      return new Response('bad request', { status: 400 })
    }
  })

  registerIpc()
  gradingEngine.setEmitter((e) => {
    broadcastGradingEvent(e)
    if (e.type === 'state' || e.type === 'stats') rebuildTrayMenu()
  })

  createSidebar()
  createTray()

  const cfg = configStore.get()
  const hk = applyHotkey(cfg.settings.hotkeyToggle)
  if (!hk.ok) logger.warn({ phase: 'app', error: hk.error })

  // 自动化初始化（nut-js → 系统脚本降级）
  void automation.init().then((s) => {
    broadcastGradingEvent({ type: 'automationImpl', impl: s.impl, ok: s.ok, message: s.message })
    logger.info({ phase: 'automation', detail: s.message })
  })
  automation.onStatus((s) => {
    broadcastGradingEvent({ type: 'automationImpl', impl: s.impl, ok: s.ok, message: s.message })
    rebuildTrayMenu()
  })

  // 局域网节点健康检查
  lanBalancer.start()

  // macOS 权限引导
  if (process.platform === 'darwin') {
    try {
      const st = systemPreferences.getMediaAccessStatus('screen')
      if (st !== 'granted') {
        logger.warn({ phase: 'app', detail: 'macOS 屏幕录制权限未授予，截屏功能将不可用' })
      }
    } catch {
      /* ignore */
    }
  }

  // 首次使用引导
  if (!configStore.get().onboardingDone) openSettings('onboarding')

  app.on('activate', () => {
    createSidebar()
  })
})

app.on('second-instance', () => {
  const cfg = configStore.get()
  if (cfg.settings.sidebarHidden) toggleSidebar('show')
  else openSettings()
})

app.on('before-quit', () => {
  configStore.saveNow()
  gradingEngine.control('stop')
  lanBalancer.stop()
  applyHotkey('')
})

app.on('window-all-closed', () => {
  // 托盘常驻：不退出，用户从托盘退出
})

// 兜底托盘图标（16×16 蓝底白字圆点）
const FALLBACK_TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAmklEQVR4nKWTSQoCMRRFz5mwadOmYtAaxY2CCq4gKvp/IJFLoC4i9Aa66SKu4ALeyt/C5e4lKGYm5557Z95nTM5LIes4xhjDLwCmwx2ccwqAYRiWSimdz8DwqNdaL631YXvN+d7TjDAMn+VyeHFd15RSEcZYEwQt9V4YY7JzTkgpUVWVhBBaa4CWZq3dsNGdn8TOx/0CS2vFhZdy8mQAAAAASUVORK5CYII='
