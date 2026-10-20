import { Key, keyboard, mouse, Button, Point } from '@nut-tree-fork/nut-js'
import { sleep, type IAutomation } from './automation-types'

const KEY_MAP: Record<string, Key> = {
  enter: Key.Enter,
  tab: Key.Tab,
  esc: Key.Escape,
  space: Key.Space,
  backspace: Key.Backspace,
  delete: Key.Delete,
  up: Key.Up,
  down: Key.Down,
  left: Key.Left,
  right: Key.Right,
  home: Key.Home,
  end: Key.End,
  f5: Key.F5
}

const MOD_MAP: Record<string, Key> = {
  ctrl: Key.LeftControl,
  alt: Key.LeftAlt,
  shift: Key.LeftShift,
  meta: Key.LeftMeta
}

/** 实现A：@nut-tree-fork/nut-js（N-API 预编译） */
export class NutAutomation implements IAutomation {
  readonly impl = 'nut' as const

  async probe(): Promise<boolean> {
    try {
      // 隐藏配置：避免每步移动都有默认延迟
      mouse.config.autoDelayMs = 10
      mouse.config.mouseSpeed = 3000
      keyboard.config.autoDelayMs = 10
      await mouse.getPosition()
      return true
    } catch {
      return false
    }
  }

  async getMousePos(): Promise<{ x: number; y: number }> {
    const p = await mouse.getPosition()
    return { x: p.x, y: p.y }
  }

  async click(x: number, y: number): Promise<void> {
    await mouse.setPosition(new Point(Math.round(x), Math.round(y)))
    await sleep(80)
    await mouse.click(Button.LEFT)
  }

  async keyTap(key: string, modifiers: Array<'ctrl' | 'alt' | 'shift' | 'meta'> = []): Promise<void> {
    const k =
      KEY_MAP[key] ??
      (key.length === 1 ? (Key as unknown as Record<string, Key>)[key.toUpperCase()] : undefined)
    if (!k) throw new Error(`不支持的按键：${key}`)
    const mods = modifiers.map((m) => MOD_MAP[m]).filter(Boolean)
    if (mods.length) await keyboard.pressKey(...mods)
    await keyboard.pressKey(k)
    await sleep(30)
    await keyboard.releaseKey(k)
    if (mods.length) await keyboard.releaseKey(...mods)
  }

  async typeText(text: string): Promise<void> {
    if (text) await keyboard.type(text)
  }
}
