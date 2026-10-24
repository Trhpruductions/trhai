import { deflateSync } from "node:zlib";

// Just enough PNG to hand pictures to ffmpeg: gray (8 or 16 bit) and RGB.
//
// The music video maker draws a few still images itself - the maps that turn a
// row of spectrum bars into a ring, the dark disc the title sits in, a layer of
// drifting dust - and gives them to ffmpeg as files. Making them here, from the
// numbers, keeps them exact and testable; the same pictures made with ffmpeg's
// own expression filters depended on how that build rounds.

export type PngKind = "gray8" | "gray16" | "rgb8";

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of the bytes, as PNG chunks carry it. (Not zlib.crc32: Node 20 before 20.15 has none.) */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/**
 * The picture as a PNG file. `pixels` holds one value per channel in reading
 * order: bytes for "gray8" and "rgb8", 0 to 65535 for "gray16".
 */
export function encodePng(width: number, height: number, pixels: Uint8Array | Uint16Array, kind: PngKind): Buffer {
  const channels = kind === "rgb8" ? 3 : 1;
  const depth = kind === "gray16" ? 16 : 8;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("A picture needs a whole, positive width and height.");
  if (pixels.length !== width * height * channels) throw new Error(`A ${width}x${height} ${kind} picture holds ${width * height * channels} values, not ${pixels.length}.`);

  const bytesPerRow = (width * channels * depth) / 8;
  // Every row starts with its filter type: 0, none.
  const raw = Buffer.alloc((bytesPerRow + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (bytesPerRow + 1);
    raw[rowStart] = 0;
    if (depth === 16) {
      for (let x = 0; x < width; x += 1) raw.writeUInt16BE(pixels[y * width + x], rowStart + 1 + x * 2);
    } else {
      for (let i = 0; i < width * channels; i += 1) raw[rowStart + 1 + i] = pixels[y * width * channels + i];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = kind === "rgb8" ? 2 : 0; // colour type: 2 is RGB, 0 is gray
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
