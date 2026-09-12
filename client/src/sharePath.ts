import type { Lang, PublicPath } from './types'

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  const words = text.split(/\s+/)
  let line = ''
  let cy = y
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cy)
      line = word
      cy += lineHeight
    } else {
      line = test
    }
  }
  if (line) {
    ctx.fillText(line, x, cy)
    cy += lineHeight
  }
  return cy
}

/** Draw a shareable Party Paths card and share/download it. */
export async function sharePathCard(opts: {
  path: PublicPath
  brand: string
  title?: string
  lang: Lang
}): Promise<'shared' | 'downloaded' | 'copied' | 'failed'> {
  const { path, brand, title, lang } = opts
  const W = 1080
  const pad = 72
  const lineH = 52
  let estimated = 280 + path.steps.length * 130
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = Math.max(720, estimated)
  const ctx = canvas.getContext('2d')
  if (!ctx) return 'failed'

  const grad = ctx.createLinearGradient(0, 0, W, canvas.height)
  grad.addColorStop(0, '#12182a')
  grad.addColorStop(0.55, '#1a2340')
  grad.addColorStop(1, '#243156')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, canvas.height)

  ctx.fillStyle = '#ff6b4a'
  ctx.beginPath()
  ctx.roundRect(pad, pad, W - pad * 2, 8, 4)
  ctx.fill()

  ctx.fillStyle = '#f7f3ea'
  ctx.font = '700 64px Fredoka, system-ui, sans-serif'
  ctx.fillText(brand, pad, pad + 90)

  if (title) {
    ctx.fillStyle = '#ffd166'
    ctx.font = '700 40px Nunito, system-ui, sans-serif'
    ctx.fillText(title, pad, pad + 150)
  }

  ctx.fillStyle = '#a8b4d0'
  ctx.font = '600 32px Nunito, system-ui, sans-serif'
  const seedLabel = lang === 'en' ? 'Seed' : 'Startord'
  let y = pad + (title ? 220 : 180)
  ctx.fillText(`${path.originName} · ${seedLabel}: ${path.seedWord}`, pad, y)
  y += 70

  for (const step of path.steps) {
    ctx.fillStyle = '#f7f3ea'
    ctx.font = '48px Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif'
    ctx.fillText(step.emojis || '❓', pad, y)
    y += 58
    ctx.fillStyle = step.correct ? '#3dd68c' : '#ff6b7a'
    ctx.font = '600 34px Nunito, system-ui, sans-serif'
    const mark = step.correct
      ? lang === 'en'
        ? 'right'
        : 'rätt'
      : lang === 'en'
        ? 'wrong'
        : 'fel'
    const line = step.correct
      ? `${step.guesserName}: ${step.guess} (${mark})`
      : `${step.guesserName}: ${step.guess} (${mark} ← ${step.meaning})`
    y = wrapText(ctx, line, pad, y, W - pad * 2, lineH) + 28
  }

  ctx.fillStyle = '#a8b4d0'
  ctx.font = '600 28px Nunito, system-ui, sans-serif'
  ctx.fillText('partypaths.com', pad, canvas.height - 48)

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png'),
  )
  if (!blob) return 'failed'

  const file = new File([blob], `party-paths-${path.seedWord}.png`, { type: 'image/png' })
  const text =
    lang === 'en'
      ? `${brand}: ${path.seedWord} → … party fail on partypaths.com`
      : `${brand}: ${path.seedWord} → … party-fail på partypaths.com`

  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: brand, text })
      return 'shared'
    }
  } catch {
    /* fall through */
  }

  try {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.click()
    URL.revokeObjectURL(url)
    return 'downloaded'
  } catch {
    try {
      await navigator.clipboard.writeText(text)
      return 'copied'
    } catch {
      return 'failed'
    }
  }
}
