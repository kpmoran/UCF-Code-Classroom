/**
 * Generates the favicon and app icons from public/ucf-pegasus.png.
 *
 * Run with `npm run build:icons`. The outputs are committed, so this only needs
 * running when the source artwork changes — but it is a script rather than a
 * one-off because the interesting decisions are here, not in the PNG bytes.
 *
 * Two of those decisions are worth knowing:
 *
 * 1. The mark sits on a UCF-gold plate rather than on transparency. The artwork
 *    is solid black, and a browser tab strip is dark in dark mode — a bare mark
 *    would be a black shape on a near-black background. The header can invert it
 *    to white (see `dark:invert`) because the page knows its own theme; a favicon
 *    does not, so it brings its own background.
 *
 * 2. The mark is inset only 6%. At 16px the Pegasus is right at the edge of
 *    legibility, and the usual generous padding tips it over into an unreadable
 *    blob — the strokes end up thinner than a pixel. Compare renders at 16px
 *    before increasing this.
 *
 * Each size is rendered from the 192px original rather than downscaled from one
 * large composite, so the artwork is resampled exactly once.
 */
import { writeFile } from 'node:fs/promises'

import sharp from 'sharp'

const SOURCE = 'public/ucf-pegasus.png'
const UCF_GOLD = 'rgb(255,201,4)'

/** One icon: gold plate, mark centred on top. `radius`/`inset` are fractions of size. */
async function render(size, { radius, inset }) {
  const r = Math.round(size * radius)
  const inner = size - 2 * Math.round(size * inset)

  const plate = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${UCF_GOLD}"/>` +
      `</svg>`,
  )
  const mark = await sharp(SOURCE)
    .resize(inner, inner, {
      fit: 'contain',
      kernel: 'lanczos3',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()

  return sharp(plate).composite([{ input: mark, gravity: 'center' }]).png().toBuffer()
}

/**
 * Packs PNGs into an .ico. Browsers have accepted PNG-compressed ICO entries
 * since IE Vista, and it keeps the alpha on the rounded corners that a BMP
 * entry would need a mask for.
 */
function buildIco(images) {
  const HEADER = 6
  const ENTRY = 16
  const dir = Buffer.alloc(HEADER + ENTRY * images.length)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // type: icon
  dir.writeUInt16LE(images.length, 4)

  let offset = dir.length
  images.forEach(({ size, data }, i) => {
    const at = HEADER + ENTRY * i
    dir.writeUInt8(size >= 256 ? 0 : size, at) // 0 encodes 256
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1)
    dir.writeUInt8(0, at + 2) // palette size: not paletted
    dir.writeUInt8(0, at + 3) // reserved
    dir.writeUInt16LE(1, at + 4) // colour planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  return Buffer.concat([dir, ...images.map((i) => i.data)])
}

const TAB = { radius: 0.22, inset: 0.06 }

async function write(path, data) {
  await writeFile(path, data)
  console.log(`  wrote ${path} (${data.length.toLocaleString()} bytes)`)
}

// The tab icon, at the three sizes browsers actually ask for.
const tabSizes = []
for (const size of [16, 32, 48]) tabSizes.push({ size, data: await render(size, TAB) })
await write('src/app/favicon.ico', buildIco(tabSizes))

// Larger contexts: the tab is not the only place this appears.
await write('src/app/icon.png', await render(512, TAB))

/*
 * Apple touch icon: iOS discards transparency and applies its own corner mask,
 * so this one is a full-bleed square with a wider inset — the mark would
 * otherwise clip where iOS rounds it.
 */
await write('src/app/apple-icon.png', await render(180, { radius: 0, inset: 0.1 }))
