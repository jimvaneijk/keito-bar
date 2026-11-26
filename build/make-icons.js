#!/usr/bin/env node
//
// Draws the app and tray icons into assets/. Run `npm run icons` after changing a
// shape below; the PNGs are committed, so this only runs when the design changes.
//
// The mark is a progress arc: 270 degrees from twelve o'clock, the quadrant between
// nine and twelve left open. Idle in the menu bar is a calm closed ring, a running
// timer is the filled arc — the two differ in mass, not in a detail you have to look
// for. Tray icons are template images: black on transparency, macOS tints them.
//
// Rendering is done here rather than with a converter because a plain Mac has no
// ImageMagick, librsvg or Inkscape, and the shapes are circles and a rounded square.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const SAMPLES = 4; // supersampling per axis

// ---------------------------------------------------------------- shapes
// Each shape is a function (x, y) => true when that point is inside it.

const TAU = Math.PI * 2;

/** Points whose angle falls within `sweep` degrees clockwise from twelve o'clock. */
function withinSweep(dx, dy, sweep) {
    const fromTwelve = (Math.atan2(dy, dx) + Math.PI / 2 + TAU) % TAU;
    return fromTwelve <= (sweep * Math.PI) / 180;
}

function ring(cx, cy, radius, width) {
    return (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - radius) <= width / 2;
}

function pie(cx, cy, radius, sweep) {
    return (x, y) => Math.hypot(x - cx, y - cy) <= radius && withinSweep(x - cx, y - cy, sweep);
}

/** Arc stroke with round caps, like SVG's stroke-linecap="round". */
function arc(cx, cy, radius, width, sweep) {
    const endAngle = ((sweep - 90) * Math.PI) / 180;
    const caps = [
        [cx, cy - radius],
        [cx + radius * Math.cos(endAngle), cy + radius * Math.sin(endAngle)],
    ];
    return (x, y) => {
        const dx = x - cx;
        const dy = y - cy;
        if (withinSweep(dx, dy, sweep) && Math.abs(Math.hypot(dx, dy) - radius) <= width / 2) return true;
        return caps.some(([capX, capY]) => Math.hypot(x - capX, y - capY) <= width / 2);
    };
}

function roundedRect(left, top, size, radius) {
    const right = left + size;
    const bottom = top + size;
    return (x, y) => {
        if (x < left || x > right || y < top || y > bottom) return false;
        const insetX = Math.max(left + radius - x, x - (right - radius), 0);
        const insetY = Math.max(top + radius - y, y - (bottom - radius), 0);
        return Math.hypot(insetX, insetY) <= radius;
    };
}

// ---------------------------------------------------------------- rendering

/**
 * Paints `layers` (back to front) into an RGBA buffer. Every pixel is sampled on a
 * SAMPLES × SAMPLES grid and the hits are averaged, so both the outer edges and the
 * seam between two layers come out smooth.
 */
function draw(size, layers) {
    const pixels = Buffer.alloc(size * size * 4);
    const step = 1 / SAMPLES;
    const total = SAMPLES * SAMPLES;
    for (let pixelY = 0; pixelY < size; pixelY++) {
        for (let pixelX = 0; pixelX < size; pixelX++) {
            let red = 0;
            let green = 0;
            let blue = 0;
            let covered = 0;
            for (let sampleY = 0; sampleY < SAMPLES; sampleY++) {
                for (let sampleX = 0; sampleX < SAMPLES; sampleX++) {
                    const x = pixelX + (sampleX + 0.5) * step;
                    const y = pixelY + (sampleY + 0.5) * step;
                    let colour = null;
                    for (const layer of layers) if (layer.inside(x, y)) colour = layer.colour;
                    if (!colour) continue;
                    red += colour[0];
                    green += colour[1];
                    blue += colour[2];
                    covered++;
                }
            }
            const offset = (pixelY * size + pixelX) * 4;
            if (covered === 0) continue;
            pixels[offset] = Math.round(red / covered);
            pixels[offset + 1] = Math.round(green / covered);
            pixels[offset + 2] = Math.round(blue / covered);
            pixels[offset + 3] = Math.round((covered / total) * 255);
        }
    }
    return pixels;
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
});

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // colour type: RGBA
    // Each row is prefixed with filter type 0 (none).
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let row = 0; row < size; row++) {
        pixels.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---------------------------------------------------------------- icons

const BLACK = [0, 0, 0];
const INK = [27, 28, 32]; // --bg-solid in dark mode
const ACCENT = [240, 102, 42]; // --accent
// --run, halfway between its light and dark value: one green has to carry both menu bars.
const RUN = [46, 182, 105];

/** Tray icons are drawn on a 16-unit grid and scaled to the requested pixel size. */
function trayIcon(size, shape, colour = BLACK) {
    const scale = size / 16;
    return draw(size, [{ colour, inside: (x, y) => shape(x / scale, y / scale) }]);
}

const idle = ring(8, 8, 5.4, 1.7);
const running = pie(8, 8, 6.3, 270);

const icons = [
    // Idle is a template image: black on transparency, tinted by macOS to match the menu bar.
    { file: 'trayTemplate.png', size: 16, render: (size) => trayIcon(size, idle) },
    { file: 'trayTemplate@2x.png', size: 32, render: (size) => trayIcon(size, idle) },
    // Running keeps its own green, so a live timer stands out between the grey icons.
    { file: 'trayRunning.png', size: 16, render: (size) => trayIcon(size, running, RUN) },
    { file: 'trayRunning@2x.png', size: 32, render: (size) => trayIcon(size, running, RUN) },
    {
        file: 'icon.png',
        size: 1024,
        render: (size) =>
            draw(size, [
                { colour: INK, inside: roundedRect(64, 64, 896, 208) },
                { colour: ACCENT, inside: arc(512, 512, 248, 124, 270) },
            ]),
    },
];

for (const { file, size, render } of icons) {
    fs.writeFileSync(path.join(ASSETS, file), encodePng(size, render(size)));
    console.log(`${file}  ${size}×${size}`);
}
