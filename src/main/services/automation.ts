import { clipboard, screen } from 'electron'
import type { Region } from '@shared/types'
import { logger } from './logger'
import { ShellAutomation } from './automation-shell'
import type { IAutomation } from './automation-types'
import { sleep } from './automation-types'

export interface AutomationStatus {
  impl: 'nut' | 'shell'
  ok: boolean
  message: string
}

/**
 * 自动化服务：包装双实现，提供点击 / 敲键 / 剪贴板粘贴（粘贴后恢复原剪贴板）。
 * 启动探针：优先 nut-js，失败自动降级系统脚本并全局事件告知 UI。
 */
class AutomationService {
  private impl: IAutomation | null = null
  private status: AutomationStatus = { impl: 'shell', ok: false, message: '未初始化' }
  private eventSink: ((s: AutomationStatus) => void) | null = null

  onStatus(cb: (s: AutomationStatus) => void): void {
    this.eventSink = cb
  }

  getStatus(): AutomationStatus {
    return this.status
  }

  async init(): Promise<AutomationStatus> {
    try {
      // 动态加载 nut-js：arm64 Linux 无预编译二进制，require 失败必须能落入降级逻辑，
      // 绝不能在模块加载阶段静态 import 导致主进程启动即崩
      const { NutAutomation } = await import('./automation-nut')
      const nut = new NutAutomation()
      if (await nut.probe()) {
        this.impl = nut
        this.status = { impl: 'nut', ok: true, message: '键鼠自动化已就绪（nut-js）' }
      } else throw new Error('nut-js 探针失败')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const shell = new ShellAutomation()
      try {
        if (await shell.probe()) {
          this.impl = shell
          this.status = { impl: 'shell', ok: true, message: `nut-js 不可用（${reason}），已自动降级为系统脚本模式` }
        } else throw new Error('系统脚本探针失败')
      } catch (err2) {
        this.impl = null
        this.status = { impl: 'shell', ok: false, message: `自动化不可用：nut-js（${reason}）；系统脚本（${err2 instanceof Error ? err2.message : String(err2)}）` }
      }
    }
    logger.warn({ phase: 'automation', detail: this.status.message, state: this.status.impl })
    this.eventSink?.(this.status)
    return this.status
  }

  private ensure(): IAutomation {
    if (!this.impl) throw new Error(this.status.message)
    return this.impl
  }

  /** OS 坐标：优先用标记时记录的物理坐标，否则按 DPI 换算 */
  private osPointFor(region: Region): { x: number; y: number } {
    const cx = region.rect.x + region.rect.w / 2
    const cy = region.rect.y + region.rect.h / 2
    if (region.phys) return { x: region.phys.x, y: region.phys.y }
    if (process.platform === 'darwin') return { x: Math.round(cx), y: Math.round(cy) }
    const d = screen.getDisplayMatching({ x: cx, y: cy, width: 1, height: 1 })
    return {
      x: Math.round(d.bounds.x + (cx - d.bounds.x) * d.scaleFactor),
      y: Math.round(d.bounds.y + (cy - d.bounds.y) * d.scaleFactor)
    }
  }

  async clickRegion(region: Region): Promise<void> {
    const pt = this.osPointFor(region)
    logger.info({ phase: 'automation', detail: `点击 (${pt.x}, ${pt.y}) [${region.label}]` })
    await this.ensure().click(pt.x, pt.y)
    await sleep(120)
  }

  async keyTap(key: string, modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'>): Promise<void> {
    await this.ensure().keyTap(key, modifiers)
    await sleep(80)
  }

  async typeText(text: string): Promise<void> {
    await this.ensure().typeText(text)
    await sleep(80)
  }

  /** 剪贴板粘贴：点击输入框后调用；粘贴完成后恢复原剪贴板内容；失败回退逐字符输入 */
  async pasteText(text: string): Promise<void> {
    let prevText = ''
    try {
      prevText = await clipboard.readText()
    } catch {
      /* ignore */
    }
    await clipboard.writeText(text)
    try {
      const mod = process.platform === 'darwin' ? 'meta' : 'ctrl'
      await this.keyTap('v', [mod as 'ctrl'])
      await sleep(180)
    } finally {
      try {
        await clipboard.writeText(prevText)
      } catch {
        /* ignore */
      }
    }
  }

  /** 点击分值输入框并填入分数：点击 → 全选 → 粘贴（降级逐字符） */
  async fillScoreBox(scoreRegion: Region, score: string): Promise<void> {
    await this.clickRegion(scoreRegion)
    await sleep(150)
    try {
      const mod = process.platform === 'darwin' ? 'meta' : 'ctrl'
      await this.keyTap('a', [mod as 'ctrl'])
      await sleep(60)
      await this.pasteText(score)
    } catch (err) {
      logger.warn({ phase: 'automation', error: `粘贴失败，回退逐字符输入：${err instanceof Error ? err.message : String(err)}` })
      await this.keyTap('a', [process.platform === 'darwin' ? 'meta' : 'ctrl'])
      await this.typeText(score)
    }
  }

  /**
   * 批量填充分小题分值：紧凑节奏（点击 → 全选 → 粘贴），逐框间仅保留最小稳定等待，
   * 剪贴板只在整批结束后恢复一次。相比逐个 fillScoreBox 约提速一半以上。
   */
  async fillScoreBoxesBatch(entries: Array<{ region: Region; score: string }>): Promise<void> {
    if (!entries.length) return
    const impl = this.ensure()
    const mod = process.platform === 'darwin' ? 'meta' : 'ctrl'
    let prevText = ''
    try {
      prevText = await clipboard.readText()
    } catch {
      /* ignore */
    }
    try {
      for (const { region, score } of entries) {
        const pt = this.osPointFor(region)
        logger.info({ phase: 'automation', detail: `批量填充 点击 (${pt.x}, ${pt.y}) [${region.label}] = ${score}` })
        await impl.click(pt.x, pt.y)
        await sleep(60)
        try {
          await impl.keyTap('a', [mod as 'ctrl'])
          await sleep(30)
          await clipboard.writeText(score)
          await impl.keyTap('v', [mod as 'ctrl'])
          await sleep(120)
        } catch (err) {
          logger.warn({ phase: 'automation', error: `粘贴失败，回退逐字符输入：${err instanceof Error ? err.message : String(err)}` })
          await impl.keyTap('a', [mod as 'ctrl'])
          await sleep(30)
          await impl.typeText(score)
          await sleep(60)
        }
      }
    } finally {
      try {
        await clipboard.writeText(prevText)
      } catch {
        /* ignore */
      }
    }
  }

  async calibrate(): Promise<AutomationStatus> {
    return this.init()
  }

  /** 当前鼠标位置（OS 坐标），用于标记时记录物理坐标 */
  async getMousePos(): Promise<{ x: number; y: number }> {
    return this.ensure().getMousePos()
  }
}

export const automation = new AutomationService()
