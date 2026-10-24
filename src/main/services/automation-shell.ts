import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { VKEY_CODES, type IAutomation } from './automation-types'

const exec = promisify(execFile)

// ---------- Windows PowerShell 脚本模板（DPI 感知） ----------
const PS_WIN_HELPER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct PT { public int X; public int Y; }
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(int value);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
}
"@
[W]::SetProcessDpiAwarenessContext(-4) | Out-Null
`

// ---------- Linux xdotool 键名映射 ----------
const XKEY_MAP: Record<string, string> = {
  enter: 'Return',
  tab: 'Tab',
  esc: 'Escape',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End'
}
const XMOD_MAP: Record<string, string> = {
  ctrl: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  meta: 'super'
}
/** 将应用层键名转为 xdotool 键名（f5→F5，单字符原样） */
function toXKey(key: string): string | undefined {
  if (XKEY_MAP[key]) return XKEY_MAP[key]
  const f = /^f(\d+)$/i.exec(key)
  if (f) return `F${f[1]}`
  if (key.length === 1) return key
  return undefined
}

/** 实现B：零依赖系统脚本（Win: PowerShell+user32 / macOS: osascript / Linux: xdotool），nut-js 不可用时自动降级 */
export class ShellAutomation implements IAutomation {
  readonly impl = 'shell' as const

  async probe(): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        await exec(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${PS_WIN_HELPER}[W]::GetCursorPos([ref]([PT]::new())) | Out-Null`],
          { timeout: 8000, windowsHide: true }
        )
        return true
      }
      if (process.platform === 'linux') {
        await exec('xdotool', ['version'], { timeout: 8000 })
        return true
      }
      await exec('osascript', ['-e', 'tell application "System Events" to get name of every process'], { timeout: 8000 })
      return true
    } catch {
      return false
    }
  }

  async getMousePos(): Promise<{ x: number; y: number }> {
    if (process.platform === 'win32') {
      const { stdout } = await exec(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `${PS_WIN_HELPER}
$p = New-Object PT
[W]::GetCursorPos([ref]$p) | Out-Null
"$($p.X) $($p.Y)"`],
        { timeout: 8000, windowsHide: true }
      )
      const m = stdout.trim().match(/(-?\d+)\s+(-?\d+)/)
      if (!m) throw new Error('无法读取鼠标位置')
      return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) }
    }
    if (process.platform === 'linux') {
      const { stdout } = await exec('xdotool', ['getmouselocation', '--shell'], { timeout: 8000 })
      const xm = /^X=(-?\d+)$/m.exec(stdout)
      const ym = /^Y=(-?\d+)$/m.exec(stdout)
      if (!xm || !ym) throw new Error('无法读取鼠标位置')
      return { x: parseInt(xm[1], 10), y: parseInt(ym[1], 10) }
    }
    throw new Error('macOS 暂不支持脚本方式读取鼠标位置，标记坐标将采用换算方式')
  }

  async click(x: number, y: number): Promise<void> {
    if (process.platform === 'win32') {
      await exec(
        'powershell.exe',
        [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `${PS_WIN_HELPER}
[W]::SetCursorPos(${Math.round(x)},${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 50
[W]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
[W]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`
        ],
        { timeout: 10000, windowsHide: true }
      )
      return
    }
    if (process.platform === 'linux') {
      await exec(
        'xdotool',
        ['mousemove', '--sync', String(Math.round(x)), String(Math.round(y)), 'click', '1'],
        { timeout: 10000 }
      )
      return
    }
    await exec(
      'osascript',
      ['-e', `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`],
      { timeout: 10000 }
    )
  }

  async keyTap(key: string, modifiers: Array<'ctrl' | 'alt' | 'shift' | 'meta'> = []): Promise<void> {
    if (process.platform === 'win32') {
      const vk = VKEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : NaN)
      if (Number.isNaN(vk)) throw new Error(`不支持的按键：${key}`)
      const useCtrl = modifiers.includes('ctrl')
      await exec(
        'powershell.exe',
        [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `${PS_WIN_HELPER}
$vk = ${vk}
if (${useCtrl ? 1 : 0}) { [W]::keybd_event(0x11,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }
[W]::keybd_event($vk,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[W]::keybd_event($vk,0,2,[UIntPtr]::Zero)
if (${useCtrl ? 1 : 0}) { [W]::keybd_event(0x11,0,2,[UIntPtr]::Zero) }`
        ],
        { timeout: 10000, windowsHide: true }
      )
      return
    }
    if (process.platform === 'linux') {
      const k = toXKey(key)
      if (!k) throw new Error(`不支持的按键：${key}`)
      const combo = [...modifiers.map((m) => XMOD_MAP[m]).filter(Boolean), k].join('+')
      await exec('xdotool', ['key', '--clearmodifiers', combo], { timeout: 10000 })
      return
    }
    // macOS key codes: a=0 v=9 c=8 x=7 enter=36 tab=48 esc=53 space=49
    const macCodes: Record<string, number> = { a: 0, c: 8, v: 9, x: 7, enter: 36, tab: 48, esc: 53, space: 49 }
    const code = macCodes[key]
    const modStr = modifiers.includes('meta')
      ? ' using {command down}'
      : modifiers.includes('ctrl')
        ? ' using {control down}'
        : ''
    if (code !== undefined) {
      await exec('osascript', ['-e', `tell application "System Events" to key code ${code}${modStr}`], { timeout: 10000 })
    } else {
      await exec('osascript', ['-e', `tell application "System Events" to keystroke "${key}"${modStr}`], { timeout: 10000 })
    }
  }

  async typeText(text: string): Promise<void> {
    if (process.platform === 'win32') {
      const safe = text.replace(/["{}()[\]]/g, '{$&}')
      await exec(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${safe}")`],
        { timeout: 10000, windowsHide: true }
      )
      return
    }
    if (process.platform === 'linux') {
      // xdotool type：-- 后为纯字面量（execFile 不经 shell，无注入风险）；非键盘字符会被跳过
      await exec('xdotool', ['type', '--delay', '60', '--clearmodifiers', '--', text], { timeout: 15000 })
      return
    }
    const safe = text.replace(/["\\]/g, '\\$&')
    await exec('osascript', ['-e', `tell application "System Events" to keystroke "${safe}"`], { timeout: 10000 })
  }
}
