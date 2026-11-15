import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ICONS, pngIcon, rasterize, readFlatSvg, readPng } from "./icons";

const SVG = readFileSync(new URL("../public/icon.svg", import.meta.url), "utf8");
const pixel = (p: { width: number; pixels: Uint8Array }, x: number, y: number) => [...p.pixels.subarray((y * p.width + x) * 3, (y * p.width + x) * 3 + 3)];

describe("home-screen icons", () => {
  it("reads the three bands of icon.svg: squash, then leek, then tomato at the bottom", () => {
    const { width, height, rects } = readFlatSvg(SVG);
    expect([width, height]).toEqual([32, 32]);
    expect(rects.map((r) => [r.y, r.height, r.rgb])).toEqual([[0, 32, [0xe8, 0xa3, 0x17]], [20, 12, [0x2f, 0x7d, 0x4f]], [26, 6, [0xc2, 0x3b, 0x22]]]);
  });

  it("draws each size as an opaque RGB PNG with the bands where the SVG puts them", () => {
    for (const { size } of ICONS) {
      const png = readPng(pngIcon(SVG, size));
      expect([png.width, png.height]).toEqual([size, size]);
      expect(pixel(png, 0, 0)).toEqual([0xe8, 0xa3, 0x17]);
      expect(pixel(png, size - 1, Math.floor(size * 0.7))).toEqual([0x2f, 0x7d, 0x4f]);
      expect(pixel(png, size / 2, size - 1)).toEqual([0xc2, 0x3b, 0x22]);
      // a band edge falls between pixels, never across one: no blended colour anywhere
      const colours = new Set<string>();
      for (let i = 0; i < png.pixels.length; i += 3) colours.add(png.pixels.subarray(i, i + 3).join(","));
      expect(colours.size).toBe(3);
    }
  });

  it("samples each pixel at its centre, so a band edge on a pixel centre goes to the lower band", () => {
    // Regression: 2c8385d — nothing pinned centre sampling: sampling at the pixel corner moved the edge by one row
    const png = readPng(pngIcon(SVG, 180));
    expect(pixel(png, 0, 111)).toEqual([0xe8, 0xa3, 0x17]); // centre 111.5 * 32 / 180 = 19.82, above the leek band at 20
    expect(pixel(png, 0, 112)).toEqual([0x2f, 0x7d, 0x4f]); // centre 112.5 * 32 / 180 = 20.0, the leek band starts here
  });

  it("reads back only the PNG layout pngIcon writes", () => {
    // Regression: 2c8385d — readPng ignored the IHDR bit depth, colour type and interlace, so an RGBA header still passed
    const png = Buffer.from(pngIcon(SVG, 8));
    png[8 + 8 + 9] = 6; // IHDR colour type: 6 = RGBA
    png.writeUInt32BE(crc32(png.subarray(12, 8 + 8 + 13)), 8 + 8 + 13);
    expect(() => readPng(png)).toThrow("8-bit RGB");
  });

  it("gives the same bytes for the same SVG, and names the files the manifest and index.html link", () => {
    expect(pngIcon(SVG, 180).equals(pngIcon(SVG, 180))).toBe(true);
    expect(ICONS.map((i) => i.name)).toEqual(["apple-touch-icon.png", "icon-192.png", "icon-512.png"]);
    const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8")) as { icons: { src: string; sizes: string }[] };
    for (const { name, size } of ICONS.filter((i) => i.name !== "apple-touch-icon.png")) {
      expect(manifest.icons).toContainEqual(expect.objectContaining({ src: `/${name}`, sizes: `${size}x${size}`, type: "image/png" }));
    }
    expect(readFileSync(new URL("../src/app/index.html", import.meta.url), "utf8")).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  });

  it("refuses an icon it cannot draw exactly, instead of drawing it wrong", () => {
    expect(() => readFlatSvg('<svg viewBox="0 0 32 32"><circle r="4" fill="#000000"/></svg>')).toThrow("only <rect>");
    expect(() => readFlatSvg('<svg viewBox="0 0 32 32"><rect width="4" height="4" fill="red"/></svg>')).toThrow("#rrggbb");
    expect(() => readFlatSvg('<svg viewBox="0 0 32 32"><rect width="4" height="4" rx="1" fill="#000000"/></svg>')).toThrow("rounding");
    expect(() => readFlatSvg('<svg><rect width="4" height="4" fill="#000000"/></svg>')).toThrow("viewBox");
    expect(rasterize('<svg viewBox="0 0 2 2"><rect width="1" height="2" fill="#ffffff"/></svg>', 2)).toEqual(new Uint8Array([255, 255, 255, 0, 0, 0, 255, 255, 255, 0, 0, 0]));
  });
});
