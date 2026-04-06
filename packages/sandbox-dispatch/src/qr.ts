/**
 * Minimal QR Code SVG generator for short URLs (~50-80 chars).
 * Supports byte mode, error correction level L, versions 1-6.
 * No external dependencies. Generates a self-contained SVG string.
 *
 * Based on the QR Code specification (ISO/IEC 18004).
 * Only implements what's needed for short URLs.
 */

// --- GF(256) arithmetic for Reed-Solomon ---

const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
  }
  EXP[255] = EXP[0];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] + LOG[b]) % 255];
}

function rsEncode(data: number[], ecCount: number): number[] {
  // Build generator polynomial
  const gen = [1];
  for (let i = 0; i < ecCount; i++) {
    const newGen = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      newGen[j] ^= gen[j];
      newGen[j + 1] ^= gfMul(gen[j], EXP[i]);
    }
    gen.length = newGen.length;
    for (let j = 0; j < newGen.length; j++) gen[j] = newGen[j];
  }

  const msg = [...data, ...new Array(ecCount).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

// --- QR Code data encoding (byte mode) ---

// Version info: [totalCodewords, ecCodewordsPerBlock, numBlocks]
const VERSION_INFO: [number, number, number][] = [
  [0, 0, 0],       // placeholder for index 0
  [26, 7, 1],      // V1-L: 26 total, 7 EC per block, 1 block
  [44, 10, 1],     // V2-L
  [70, 15, 1],     // V3-L
  [100, 20, 1],    // V4-L
  [134, 26, 1],    // V5-L
  [172, 18, 2],    // V6-L
];

function selectVersion(dataLen: number): number {
  // Byte mode overhead: 4 (mode) + 8/16 (count) + data*8 + terminator
  for (let v = 1; v <= 6; v++) {
    const [total, ec, blocks] = VERSION_INFO[v];
    const dataCodewords = total - ec * blocks;
    const countBits = v <= 9 ? 8 : 16;
    const availBits = dataCodewords * 8;
    const needed = 4 + countBits + dataLen * 8;
    if (needed <= availBits) return v;
  }
  return 6; // max supported
}

function encodeData(text: string, version: number): number[] {
  const [total, ecPerBlock, numBlocks] = VERSION_INFO[version];
  const dataCodewords = total - ecPerBlock * numBlocks;
  const countBits = version <= 9 ? 8 : 16;

  // Build bit stream: mode(4) + count + data + terminator
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // byte mode
  pushBits(text.length, countBits);
  for (let i = 0; i < text.length; i++) pushBits(text.charCodeAt(i), 8);
  pushBits(0, Math.min(4, dataCodewords * 8 - bits.length)); // terminator

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Convert to bytes
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }

  // Pad with 236/17 alternating
  let pad = 0;
  while (codewords.length < dataCodewords) {
    codewords.push(pad % 2 === 0 ? 236 : 17);
    pad++;
  }

  // Error correction
  const blockSize = Math.floor(dataCodewords / numBlocks);
  const allData: number[][] = [];
  const allEc: number[][] = [];
  let offset = 0;

  for (let b = 0; b < numBlocks; b++) {
    const size = b < numBlocks - (dataCodewords % numBlocks) ? blockSize : blockSize + 1;
    const block = codewords.slice(offset, offset + size);
    allData.push(block);
    allEc.push(rsEncode(block, ecPerBlock));
    offset += size;
  }

  // Interleave
  const result: number[] = [];
  const maxDataLen = Math.max(...allData.map((d) => d.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of allData) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of allEc) if (i < block.length) result.push(block[i]);
  }

  return result;
}

// --- QR Code matrix ---

function createMatrix(version: number): { matrix: number[][]; size: number } {
  const size = 17 + version * 4;
  const matrix = Array.from({ length: size }, () => new Array(size).fill(-1));

  // Finder patterns
  const drawFinder = (r: number, c: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        if (dr === -1 || dr === 7 || dc === -1 || dc === 7) matrix[rr][cc] = 0;
        else if (dr === 0 || dr === 6 || dc === 0 || dc === 6) matrix[rr][cc] = 1;
        else if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) matrix[rr][cc] = 1;
        else matrix[rr][cc] = 0;
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Dark module
  matrix[size - 8][8] = 1;

  // Alignment pattern (version >= 2)
  if (version >= 2) {
    const pos = [6, size - 7];
    for (const r of pos) {
      for (const c of pos) {
        if (matrix[r][c] !== -1) continue; // skip if overlaps finder
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const val = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0) ? 1 : 0;
            matrix[r + dr][c + dc] = val;
          }
        }
      }
    }
  }

  // Reserve format info areas
  for (let i = 0; i < 8; i++) {
    if (matrix[8][i] === -1) matrix[8][i] = 0;
    if (matrix[i][8] === -1) matrix[i][8] = 0;
    if (matrix[8][size - 1 - i] === -1) matrix[8][size - 1 - i] = 0;
    if (matrix[size - 1 - i][8] === -1) matrix[size - 1 - i][8] = 0;
  }
  if (matrix[8][8] === -1) matrix[8][8] = 0;

  return { matrix, size };
}

function placeData(matrix: number[][], size: number, data: number[]): void {
  const bits: number[] = [];
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;

  for (let col = size - 1; col >= 0; col -= 2) {
    if (col === 6) col = 5; // skip timing column

    const rows = upward
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const row of rows) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || matrix[row][c] !== -1) continue;
        matrix[row][c] = bitIdx < bits.length ? bits[bitIdx++] : 0;
      }
    }
    upward = !upward;
  }
}

function applyMask(matrix: number[][], size: number): void {
  // Mask pattern 0: (row + col) % 2 === 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isReserved(matrix, r, c, size)) continue;
      if ((r + c) % 2 === 0) matrix[r][c] ^= 1;
    }
  }

  // Write format info for mask 0, EC level L
  // Pre-computed: L=01, mask=000 → format bits = 111011111000100
  const formatBits = 0b111011111000100;
  const formatPositions = getFormatPositions(size);
  for (let i = 0; i < 15; i++) {
    const bit = (formatBits >> (14 - i)) & 1;
    for (const [r, c] of formatPositions[i]) {
      matrix[r][c] = bit;
    }
  }
}

function isReserved(matrix: number[][], r: number, c: number, size: number): boolean {
  // Finder + separators
  if (r <= 8 && c <= 8) return true;
  if (r <= 8 && c >= size - 8) return true;
  if (r >= size - 8 && c <= 8) return true;
  // Timing
  if (r === 6 || c === 6) return true;
  // Alignment (simplified — check if we placed it)
  return false;
}

function getFormatPositions(size: number): [number, number][][] {
  const positions: [number, number][][] = [];
  // Around top-left finder
  const topLeft: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  // Around bottom-left and top-right finders
  const other: [number, number][] = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
    [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
    [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  for (let i = 0; i < 15; i++) {
    positions.push([topLeft[i], other[i]]);
  }
  return positions;
}

// --- SVG output ---

export function generateQrSvg(text: string, moduleSize = 2, margin = 1): string {
  const version = selectVersion(text.length);
  const data = encodeData(text, version);
  const { matrix, size } = createMatrix(version);
  placeData(matrix, size, data);
  applyMask(matrix, size);

  const totalSize = (size + margin * 2) * moduleSize;
  let paths = "";

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c] === 1) {
        const x = (c + margin) * moduleSize;
        const y = (r + margin) * moduleSize;
        paths += `M${x},${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${totalSize}" height="${totalSize}"><rect width="${totalSize}" height="${totalSize}" fill="#fff" rx="3"/><path d="${paths}" fill="#000"/></svg>`;
}
