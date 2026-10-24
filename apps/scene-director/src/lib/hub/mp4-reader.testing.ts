/**
 * Reads back what Mp4Writer writes (sd-export): the box tree, the track's numbers, the sample table and each sample's
 * bytes. For the specs and verify-page; there is no ffprobe on dbxpc.
 */

export interface Mp4Box {
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  /**
   * Where the payload starts (after the size, the type and a 64-bit size).
   */
  readonly body: number;
  readonly children: Mp4Box[];
}

export interface Mp4Reading {
  readonly boxes: Mp4Box[];
  readonly brands: string[];
  readonly mdat: { readonly offset: number; readonly size: number; readonly largeSize: boolean };
  readonly mvhd: { readonly timescale: number; readonly duration: number; readonly nextTrack: number };
  readonly tkhd: { readonly flags: number; readonly track: number; readonly width: number; readonly height: number };
  readonly mdhd: { readonly timescale: number; readonly duration: number };
  readonly handler: string;
  readonly entry: { readonly type: string; readonly size: number; readonly width: number; readonly height: number; readonly config: Uint8Array; readonly colr?: { readonly primaries: number; readonly transfer: number; readonly matrix: number; readonly fullRange: number }; readonly pasp?: [number, number] };
  readonly stts: [number, number][];
  readonly ctts?: { readonly version: number; readonly entries: [number, number][] };
  readonly stss: number[];
  readonly sizes: number[];
  readonly offsets: number[];
  readonly samples: Uint8Array[];
  /**
   * Seconds: mdhd duration / timescale.
   */
  readonly seconds: number;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'dinf', 'stbl']);

/**
 * Parses an MP4.
 *
 * @param bytes - The file.
 * @returns What it holds.
 */
export function ReadMp4(bytes: Uint8Array): Mp4Reading {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const parse = (start: number, end: number): Mp4Box[] => {
    const boxes: Mp4Box[] = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      const type = text(offset + 4, 4);
      let body = offset + 8;
      if (size === 1) {
        size = Number(view.getBigUint64(offset + 8));
        body += 8;
      } else if (size === 0) size = end - offset;
      if (size < 8 || offset + size > end) throw new Error(`box ${type} at ${offset} runs past its parent (${size})`);
      boxes.push({ type, offset, size, body, children: CONTAINERS.has(type) ? parse(body, offset + size) : [] });
      offset += size;
    }
    return boxes;
  };
  const boxes = parse(0, bytes.byteLength);
  const find = (path: string): Mp4Box => {
    let list = boxes;
    let found: Mp4Box | undefined;
    for (const type of path.split('/')) {
      found = list.find((box) => box.type === type);
      if (!found) throw new Error(`no ${path} box`);
      list = found.children;
    }
    return found as Mp4Box;
  };
  const maybe = (path: string): Mp4Box | undefined => {
    try {
      return find(path);
    } catch {
      return undefined;
    }
  };
  const ftyp = find('ftyp');
  const brands = [text(ftyp.body, 4), ...Array.from({ length: (ftyp.offset + ftyp.size - ftyp.body - 8) / 4 }, (_, index) => text(ftyp.body + 8 + index * 4, 4))];
  const mdat = find('mdat');
  const mvhd = find('moov/mvhd');
  const tkhd = find('moov/trak/tkhd');
  const mdhd = find('moov/trak/mdia/mdhd');
  const hdlr = find('moov/trak/mdia/hdlr');
  const stbl = 'moov/trak/mdia/minf/stbl';
  const stsd = find(`${stbl}/stsd`);
  const entryOffset = stsd.body + 8;
  const entrySize = view.getUint32(entryOffset);
  const entryChildren = parse(entryOffset + 8 + 78, entryOffset + entrySize);
  const config = entryChildren[0];
  const colr = entryChildren.find((box) => box.type === 'colr');
  const pasp = entryChildren.find((box) => box.type === 'pasp');
  const table = (box: Mp4Box, width: number) => Array.from({ length: view.getUint32(box.body + 4) }, (_, index) => box.body + 8 + index * width);
  const stts = find(`${stbl}/stts`);
  const cttsBox = maybe(`${stbl}/ctts`);
  const stsz = find(`${stbl}/stsz`);
  const co64 = find(`${stbl}/co64`);
  const sizes = Array.from({ length: view.getUint32(stsz.body + 8) }, (_, index) => view.getUint32(stsz.body + 12 + index * 4));
  const offsets = table(co64, 8).map((at) => Number(view.getBigUint64(at)));
  const mdhdTimescale = view.getUint32(mdhd.body + 12);
  const mdhdDuration = view.getUint32(mdhd.body + 16);
  return {
    boxes,
    brands,
    mdat: { offset: mdat.offset, size: mdat.size, largeSize: view.getUint32(mdat.offset) === 1 },
    mvhd: { timescale: view.getUint32(mvhd.body + 12), duration: view.getUint32(mvhd.body + 16), nextTrack: view.getUint32(mvhd.body + 96) },
    tkhd: { flags: view.getUint32(tkhd.body) & 0xffffff, track: view.getUint32(tkhd.body + 12), width: view.getUint32(tkhd.body + 76) / 0x10000, height: view.getUint32(tkhd.body + 80) / 0x10000 },
    mdhd: { timescale: mdhdTimescale, duration: mdhdDuration },
    handler: text(hdlr.body + 8, 4),
    entry: {
      type: text(entryOffset + 4, 4),
      size: entrySize,
      width: view.getUint16(entryOffset + 8 + 24),
      height: view.getUint16(entryOffset + 8 + 26),
      config: bytes.slice(config.body, config.offset + config.size),
      ...(colr ? { colr: { primaries: view.getUint16(colr.body + 4), transfer: view.getUint16(colr.body + 6), matrix: view.getUint16(colr.body + 8), fullRange: bytes[colr.body + 10] >> 7 } } : {}),
      ...(pasp ? { pasp: [view.getUint32(pasp.body), view.getUint32(pasp.body + 4)] as [number, number] } : {})
    },
    stts: table(stts, 8).map((at) => [view.getUint32(at), view.getUint32(at + 4)]),
    ...(cttsBox ? { ctts: { version: bytes[cttsBox.body], entries: table(cttsBox, 8).map((at) => [view.getUint32(at), view.getInt32(at + 4)] as [number, number]) } } : {}),
    stss: table(find(`${stbl}/stss`), 4).map((at) => view.getUint32(at)),
    sizes,
    offsets,
    samples: offsets.map((offset, index) => bytes.slice(offset, offset + sizes[index])),
    seconds: mdhdDuration / mdhdTimescale
  };
}
