import { deflateRawSync } from "node:zlib";
import { crc32 } from "./png.js";

// A zip archive written from a list of named files.
//
// Word, Excel and PowerPoint files are zip archives of XML, so making one needs
// no more than this: stored or deflated entries, a central directory, UTF-8
// names. Zip64 and encryption are not needed for documents and are not written;
// an archive that would need them is refused rather than written wrong.
// (documentText.ts has the reading half, and the tests read what this writes.)

export type ZipEntry = { name: string; data: Buffer | string };

/** The date and time a zip entry carries, in the two 16-bit fields DOS defined. Years before 1980 cannot be written. */
export function dosDateTime(when: Date): { date: number; time: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2)
  };
}

const maxEntries = 0xfffe;
const maxBytes = 0xfffffffe;

export function writeZip(entries: ZipEntry[], options: { date?: Date } = {}): Buffer {
  if (entries.length > maxEntries) throw new Error("There are too many files for one archive.");
  const { date, time } = dosDateTime(options.date ?? new Date());
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    if (name.length === 0 || name.length > 0xffff) throw new Error(`The file name "${entry.name.slice(0, 40)}" cannot be put in an archive.`);
    if (seen.has(entry.name)) throw new Error(`The archive would hold "${entry.name}" twice.`);
    seen.add(entry.name);

    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const deflated = raw.length > 32 ? deflateRawSync(raw, { level: 6 }) : null;
    const compressed = deflated && deflated.length < raw.length ? deflated : null;
    const body = compressed ?? raw;
    const method = compressed ? 8 : 0;
    if (raw.length > maxBytes || body.length > maxBytes || offset > maxBytes) throw new Error("The archive would be too large.");
    const checksum = crc32(raw);

    // 0x0800: the name is UTF-8. Version 20 (2.0) is what deflate needs.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  if (offset + directorySize > maxBytes) throw new Error("The archive would be too large.");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}
