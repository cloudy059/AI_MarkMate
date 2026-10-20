import { desktopCapturer, screen, type Rectangle, type NativeImage } from 'electron'
import type { Rect } from '@shared/types'

export class CaptureError extends Error {}

/**
 * 截取指定显示器上的 DIP 矩形区域。
 * 坐标换算：物理像素 = (DIP - display.bounds.origin) × scaleFactor，并用实测尺寸二次修正。
 */
export async function captureRegion(rect: Rect, displayId: number): Promise<NativeImage> {
  const displays = screen.getAllDisplays()
  const display =
    displays.find((d) => d.id === displayId) ??
    screen.getDisplayMatching({ x: rect.x, y: rect.y, width: Math.max(rect.w, 1), height: Math.max(rect.h, 1) })
  const scale = display.scaleFactor
  const physW = Math.max(1, Math.round(display.size.width * scale))
  const physH = Math.max(1, Math.round(display.size.height * scale))

  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: physW, height: physH }
    })
  } catch (err) {
    throw new CaptureError(`截屏失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!sources.length) {
    throw new CaptureError(
      process.platform === 'darwin'
        ? '无法获取屏幕画面：请在「系统设置 → 隐私与安全性 → 屏幕录制」中授权本应用后重启'
        : '无法获取屏幕画面（未找到可用显示器源）'
    )
  }
  const source =
    sources.find((s) => s.display_id === String(display.id)) ??
    sources.find((s) => {
      // macOS display_id 可能为空，按尺寸匹配兜底
      const sz = s.thumbnail.getSize()
      return Math.abs(sz.width - physW) < 4 && Math.abs(sz.height - physH) < 4
    }) ??
    sources[0]

  const img = source.thumbnail
  const actual = img.getSize()
  const corrX = actual.width / (display.size.width * scale)
  const corrY = actual.height / (display.size.height * scale)
  const cropRect: Rectangle = {
    x: Math.max(0, Math.round((rect.x - display.bounds.x) * scale * corrX)),
    y: Math.max(0, Math.round((rect.y - display.bounds.y) * scale * corrY)),
    width: Math.max(1, Math.round(rect.w * scale * corrX)),
    height: Math.max(1, Math.round(rect.h * scale * corrY))
  }
  // 防越界
  cropRect.width = Math.min(cropRect.width, actual.width - cropRect.x)
  cropRect.height = Math.min(cropRect.height, actual.height - cropRect.y)
  if (cropRect.width < 1 || cropRect.height < 1) throw new CaptureError('截屏区域越界，请重新标记答题区域')
  return img.crop(cropRect)
}

/** DIP 屏幕点 → OS 坐标（Windows=物理像素；macOS=点坐标一致） */
export function dipToOsPoint(x: number, y: number): { x: number; y: number } {
  if (process.platform === 'darwin') return { x: Math.round(x), y: Math.round(y) }
  const d = screen.getDisplayMatching({ x, y, width: 1, height: 1 })
  return {
    x: Math.round(d.bounds.x + (x - d.bounds.x) * d.scaleFactor),
    y: Math.round(d.bounds.y + (y - d.bounds.y) * d.scaleFactor)
  }
}
