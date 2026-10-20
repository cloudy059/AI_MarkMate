import type { NativeImage } from 'electron'

/** dHash 感知哈希（64bit），用于同题检测防重复提交 */
export function dHash(img: NativeImage): string {
  const small = img.resize({ width: 9, height: 8 })
  const buf = small.toBitmap() // BGRA
  const luma = (i: number): number => {
    const b = buf[i]
    const g = buf[i + 1]
    const r = buf[i + 2]
    return 0.299 * r + 0.587 * g + 0.114 * b
  }
  let bits = ''
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = luma((row * 9 + col) * 4)
      const right = luma((row * 9 + col + 1) * 4)
      bits += left > right ? '1' : '0'
    }
  }
  return bits
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
}

/** 判定两截图是否为同一题（汉明距离 ≤ 6）。
 * 阈值需收紧：答题区域含题干/边框等静态内容时，不同学生的页面距离也可能较小，
 * 阈值过宽会把已翻页误判为同题；同一页面重复截屏的噪声通常 ≤ 4，6 已留余量。 */
export function isSameQuestion(hashA: string | undefined, hashB: string | undefined): boolean {
  if (!hashA || !hashB) return false
  return hammingDistance(hashA, hashB) <= 6
}

/** 画面墨迹占比（暗像素比例）：用于空白卷检测 */
export function inkRatio(img: NativeImage): number {
  const small = img.resize({ width: 64, height: 64 })
  const buf = small.toBitmap() // BGRA
  let ink = 0
  for (let i = 0; i < buf.length; i += 4) {
    const luma = 0.299 * buf[i + 2] + 0.587 * buf[i + 1] + 0.114 * buf[i]
    if (luma < 128) ink++
  }
  return ink / (buf.length / 4)
}

/** 墨迹占比低于此值视为空白卷：不同空白卷画面几乎一致，哈希无法区分是否翻页 */
export const BLANK_INK_RATIO = 0.01
