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

/** Straight stroke with round caps: the crown and the hand of the stopwatch. */
function segment(x1, y1, x2, y2, width) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    return (x, y) => {
        const along = lengthSquared === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / lengthSquared;
        const clamped = Math.max(0, Math.min(1, along));
        return Math.hypot(x - (x1 + clamped * dx), y - (y1 + clamped * dy)) <= width / 2;
    };
}

const union =
    (...shapes) =>
    (x, y) =>
        shapes.some((shape) => shape(x, y));

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

function encodePng(width, height, pixels) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // colour type: RGBA
    // Each row is prefixed with filter type 0 (none).
    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let row = 0; row < height; row++) {
        pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
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

// A clock face, not a bare circle: at 16 pixels the hands are what say "time". No crown on
// top — a stem above an upright hand reads as the power symbol, not as a stopwatch.
const BODY = { x: 8, y: 8, radius: 5.2 };
const STROKE = 1.6;
const FRAMES = 12; // one per tick; a full turn takes twelve seconds

const face = ring(BODY.x, BODY.y, BODY.radius, STROKE);

/** Hand pointing `step` twelfths of a turn clockwise from twelve o'clock. */
function hand(step, length, width = 1.5) {
    const angle = (step / FRAMES) * TAU - Math.PI / 2;
    return segment(BODY.x, BODY.y, BODY.x + length * Math.cos(angle), BODY.y + length * Math.sin(angle), width);
}

const SHORT = 2.5;
const LONG = 3.3;

const idle = union(face, hand(0, SHORT), hand(3, LONG));
/** Running frame: the short hand stays put, the long one ticks a twelfth further. */
const runningFrame = (step) => union(face, hand(0, SHORT), hand(step, LONG));

const frameFiles = [];
for (let step = 0; step < FRAMES; step++) {
    frameFiles.push(
        { file: `trayRunning-${step}.png`, size: 16, render: (size) => trayIcon(size, runningFrame(step), RUN) },
        { file: `trayRunning-${step}@2x.png`, size: 32, render: (size) => trayIcon(size, runningFrame(step), RUN) },
    );
}

const icons = [
    // Idle is a template image: black on transparency, tinted by macOS to match the menu bar.
    { file: 'trayTemplate.png', size: 16, render: (size) => trayIcon(size, idle) },
    { file: 'trayTemplate@2x.png', size: 32, render: (size) => trayIcon(size, idle) },
    // Running keeps its own green and ticks, so a live timer is both visible and alive.
    ...frameFiles,
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

if (require.main === module) {
    for (const { file, size, render } of icons) {
        fs.writeFileSync(path.join(ASSETS, file), encodePng(size, size, render(size)));
        console.log(`${file}  ${size}×${size}`);
    }
}

// Exported so a preview can compose the very same shapes instead of a copy that drifts.
module.exports = {
    draw,
    encodePng,
    trayIcon,
    ring,
    pie,
    arc,
    segment,
    union,
    face,
    hand,
    idle,
    runningFrame,
    BODY,
    FRAMES,
    RUN,
};
