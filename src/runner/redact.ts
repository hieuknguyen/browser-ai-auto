import { inflateRawSync } from 'node:zlib';

export function createRedactor(values: Iterable<string>) {
  const secrets = [...new Set(values)].filter(v => v.length > 0).sort((a, b) => b.length - a.length);
  return (value: string): string => {
    let output = value;
    for (const secret of secrets) {
      if (secret.length < 3) { if (output === secret) output = '[REDACTED]'; continue; }
      output = output.split(secret).join('[REDACTED]');
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) output = output.split(escaped).join('[REDACTED]');
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) output = output.split(encoded).join('[REDACTED]');
    }
    return output.replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:token|key|secret|password|authorization|code)=)[^&\s"'<>]*/gi, '$1[REDACTED]');
  };
}

export function redactStructured(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactStructured(item, redact));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStructured(item, redact)]));
  return value;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const b of data) crc = crcTable[(crc ^ b) & 255]! ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }

/** Rebuild the Playwright ZIP, scrubbing textual entries before they become public artifacts. */
export function redactTraceZip(input: Buffer, redact: (value: string) => string): Buffer {
  let end = input.length - 22;
  while (end >= Math.max(0, input.length - 65_557) && input.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || input.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid trace ZIP');
  const entries = input.readUInt16LE(end + 10);
  let cursor = input.readUInt32LE(end + 16);
  const records: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (let index = 0; index < entries; index++) {
    if (input.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid trace entry');
    const method = input.readUInt16LE(cursor + 10), compressedSize = input.readUInt32LE(cursor + 20);
    const nameLength = input.readUInt16LE(cursor + 28), extraLength = input.readUInt16LE(cursor + 30), commentLength = input.readUInt16LE(cursor + 32);
    const originalOffset = input.readUInt32LE(cursor + 42), name = input.subarray(cursor + 46, cursor + 46 + nameLength);
    const start = originalOffset + 30 + input.readUInt16LE(originalOffset + 26) + input.readUInt16LE(originalOffset + 28);
    const compressed = input.subarray(start, start + compressedSize);
    const raw = method === 8 ? inflateRawSync(compressed) : method === 0 ? compressed : (() => { throw new Error('Unsupported trace ZIP compression'); })();
    const decoded = raw.toString('utf8');
    let data = raw;
    if (Buffer.from(decoded, 'utf8').equals(raw)) {
      if (/\.(trace|network|stacks)$/.test(name.toString())) {
        data = Buffer.from(decoded.split('\n').map(line => {
          if (!line.trim()) return line;
          // Redact string values, preserving JSON delimiters, protocol keys, and numeric IDs.
          return JSON.stringify(redactStructured(JSON.parse(line), redact));
        }).join('\n'));
      } else data = Buffer.from(redact(decoded));
    }
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    records.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  const directory = Buffer.concat(central), footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries, 8); footer.writeUInt16LE(entries, 10); footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, directory, footer]);
}
