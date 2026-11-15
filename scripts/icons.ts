import { crc32, deflateSync, inflateSync } from "node:zlib";

/**
 * The home-screen icons, drawn from public/icon.svg at build time (vite.config.ts), so no binary is ever committed or
 * edited by hand: the same SVG always gives the same bytes. The icon is flat rectangles, which is all this reads; any
 * other element, a transform or a non-hex fill throws, so a redrawn icon fails the build instead of rendering wrong.
 */
export const ICONS: readonly { name: string; size: number }[] = [
  { name: "apple-touch-icon.png", size: 180 },
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  rgb: [number, number, number];
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The viewBox and the rectangles of a flat SVG, in paint order; throws on anything else. */
export function readFlatSvg(svg: string): { width: number; height: number; rects: Rect[] } {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0];
  const box = root && attr(root, "viewBox")?.trim().split(/\s+/).map(Number);
  if (!box || box.length !== 4 || box[0] !== 0 || box[1] !== 0 || !(box[2]! > 0 && box[3]! > 0)) throw new Error("icon.svg: a viewBox 0 0 W H is required");
  const rects: Rect[] = [];
  for (const [tag, name] of svg.matchAll(/<\/?([a-zA-Z][\w:-]*)\b[^>]*>/g)) {
    if (name === "svg") continue;
    if (name !== "rect" || tag!.startsWith("</")) throw new Error(`icon.svg: only <rect> is drawn, found <${tag!.startsWith("</") ? "/" : ""}${name}>`);
    if (attr(tag!, "transform") !== undefined || attr(tag!, "rx") !== undefined || attr(tag!, "ry") !== undefined) throw new Error("icon.svg: a rect is drawn without transform or rounding");
    const fill = /^#([0-9a-fA-F]{6})$/.exec(attr(tag!, "fill") ?? "")?.[1];
    if (!fill) throw new Error("icon.svg: every rect needs a #rrggbb fill");
    const num = (n: string, fallback?: number) => {
      const v = attr(tag!, n);
      const value = v === undefined ? fallback : Number(v);
      if (value === undefined || !Number.isFinite(value)) throw new Error(`icon.svg: rect ${n} must be a number`);
      return value;
    };
    rects.push({
      x: num("x", 0), y: num("y", 0), width: num("width"), height: num("height"),
      rgb: [parseInt(fill.slice(0, 2), 16), parseInt(fill.slice(2, 4), 16), parseInt(fill.slice(4, 6), 16)],
    });
  }
  if (rects.length === 0) throw new Error("icon.svg: nothing to draw");
  return { width: box[2]!, height: box[3]!, rects };
}

/** RGB pixels, row by row: each pixel takes the last rect that covers its centre (SVG paint order), black if none. */
export function rasterize(svg: string, size: number): Uint8Array {
  const { width, height, rects } = readFlatSvg(svg);
  const pixels = new Uint8Array(size * size * 3);
  for (let py = 0; py < size; py++) {
    const cy = ((py + 0.5) * height) / size;
    for (let px = 0; px < size; px++) {
      const cx = ((px + 0.5) * width) / size;
      for (let i = rects.length - 1; i >= 0; i--) {
        const r = rects[i]!;
        if (cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height) {
          pixels.set(r.rgb, (py * size + px) * 3);
          break;
        }
      }
    }
  }
  return pixels;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A square 8-bit RGB PNG of the SVG, opaque (iOS fills transparency with black), each row unfiltered. */
export function pngIcon(svg: string, size: number): Buffer {
  const pixels = rasterize(svg, size);
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) raw.set(pixels.subarray(y * size * 3, (y + 1) * size * 3), y * (size * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, deflate, no filter method, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Reads back what pngIcon writes (tests, and the build's own check): size and RGB pixels. */
export function readPng(png: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const buf = Buffer.from(png);
  if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (buf.readUInt32BE(at + 8 + length) !== crc32(buf.subarray(at + 4, at + 8 + length))) throw new Error(`bad CRC in ${type}`);
    if (type === "IHDR") {
      if (!body.subarray(8, 13).equals(Buffer.from([8, 2, 0, 0, 0]))) throw new Error("PNG: only 8-bit RGB, unfiltered, not interlaced is read");
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
    }
    if (type === "IDAT") data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) pixels.set(raw.subarray(y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1)), y * width * 3);
  return { width, height, pixels };
}
