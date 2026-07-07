import { callName } from './calls';

export interface ParsedSubRequest {
  readonly msgType: number;
  readonly name: string;
  readonly len: number;
  readonly body: Buffer;
}

export interface ParsedRequest {
  readonly encap?: number;
  readonly msgType?: number;
  readonly name: string;
  readonly session?: string;
  readonly batchMode?: number;
  readonly subs?: ParsedSubRequest[];
  readonly args?: Buffer;
  readonly error?: string;
}

export function readVarint(buf: Buffer, pos: number): [number, number] {
  let value = 0;
  let b = 0;

  do {
    if (pos >= buf.length) {
      throw new Error('unexpected EOF while reading varint');
    }
    b = buf[pos] ?? 0;
    pos += 1;
    value = (value << 7) | (b & 0x7f);
  } while ((b & 0x80) !== 0);

  return [value >>> 0, pos];
}

export function readString(buf: Buffer, pos: number): [string, number] {
  let count = 0;
  [count, pos] = readVarint(buf, pos);

  let value = '';
  for (let i = 0; i < count; i += 1) {
    let b = buf[pos] ?? 0;
    pos += 1;

    if (b >> 4 <= 7) {
      value += String.fromCharCode(b);
    } else if (b >> 4 === 12 || b >> 4 === 13) {
      b = ((b & 0x1f) << 6) | ((buf[pos] ?? 0) & 0x3f);
      pos += 1;
      value += String.fromCharCode(b);
    } else if (b >> 4 === 14) {
      b = ((b & 0x0f) << 12) | (((buf[pos] ?? 0) & 0x3f) << 6) | ((buf[pos + 1] ?? 0) & 0x3f);
      pos += 2;
      value += String.fromCharCode(b);
    } else {
      throw new Error(`malformed UTF-8 byte ${b}`);
    }
  }

  return [value, pos];
}

export function writeVarint(value: number): Buffer {
  let n = value >>> 0;
  const groups: number[] = [];

  do {
    groups.unshift(n & 0x7f);
    n = Math.floor(n / 128);
  } while (n > 0);

  for (let i = 0; i < groups.length - 1; i += 1) {
    groups[i] = (groups[i] ?? 0) | 0x80;
  }

  return Buffer.from(groups);
}

export function writeIntvar32(value: number): Buffer {
  const encoded = value < 0 ? (((~value) << 1) | 1) >>> 0 : (value << 1) >>> 0;
  return writeVarint(encoded);
}

export function writeString(value: string): Buffer {
  const utf8 = Buffer.from(value, 'utf8');
  return Buffer.concat([writeVarint([...value].length), utf8]);
}

export function writeBool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

export function writeU8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

export function writeDate(epochSeconds: number): Buffer {
  return writeVarint(epochSeconds);
}

export function writeArray(items: readonly Buffer[]): Buffer {
  return Buffer.concat([writeVarint(items.length), ...items]);
}

export function writeNetworkUid(network: number, networkUid: string, playfishUid = 0): Buffer {
  if (network === 0) {
    return writeVarint(0);
  }

  return Buffer.concat([writeVarint(network), writeString(networkUid), writeVarint(playfishUid)]);
}

export function parseRequest(buf: Buffer): ParsedRequest {
  try {
    let pos = 0;
    const encap = buf[pos];
    const msgType = buf[pos + 1];
    pos += 2;

    let session = '';
    [session, pos] = readString(buf, pos);

    const info: ParsedRequest = {
      encap,
      msgType,
      name: callName(msgType),
      session,
    };

    if (msgType === 255) {
      const batchMode = buf[pos];
      pos += 1;

      let count = 0;
      [count, pos] = readVarint(buf, pos);

      const subs: ParsedSubRequest[] = [];
      for (let i = 0; i < count; i += 1) {
        const subMsgType = buf[pos] ?? 0;
        pos += 1;

        let len = 0;
        [len, pos] = readVarint(buf, pos);

        const body = buf.subarray(pos, pos + len);
        pos += len;

        subs.push({
          msgType: subMsgType,
          name: callName(subMsgType),
          len,
          body,
        });
      }

      return { ...info, batchMode, subs };
    }

    return { ...info, args: buf.subarray(pos) };
  } catch (error) {
    const msgType = buf[1];
    return {
      msgType,
      name: callName(msgType),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
