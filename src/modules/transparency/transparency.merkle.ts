import { createHash, timingSafeEqual } from 'node:crypto';

export const HASH_BYTES = 32;
export const MAX_TREE_SIZE = 2 ** 48;

export interface NodeSource {
  node(level: number, index: number): Buffer;
}

export function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
  }
  return hash.digest();
}

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export function hashLeaf(data: Buffer): Buffer {
  return sha256(LEAF_PREFIX, data);
}

export function hashChildren(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

export function emptyRoot(): Buffer {
  return sha256();
}

export function hashesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }
  return k;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && Number.isInteger(Math.log2(n));
}

function subtreeHash(source: NodeSource, start: number, length: number): Buffer {
  if (isPowerOfTwo(length) && start % length === 0) {
    return source.node(Math.log2(length), start / length);
  }
  const split = largestPowerOfTwoBelow(length);
  return hashChildren(subtreeHash(source, start, split), subtreeHash(source, start + split, length - split));
}

export function rootHash(source: NodeSource, size: number): Buffer {
  return size === 0 ? emptyRoot() : subtreeHash(source, 0, size);
}

export function inclusionProof(source: NodeSource, index: number, size: number): Buffer[] {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) {
    throw new RangeError('leaf index out of range');
  }
  const path: Buffer[] = [];
  let start = 0;
  let length = size;
  let position = index;
  while (length > 1) {
    const split = largestPowerOfTwoBelow(length);
    if (position < split) {
      path.push(subtreeHash(source, start + split, length - split));
      length = split;
    } else {
      path.push(subtreeHash(source, start, split));
      start += split;
      position -= split;
      length -= split;
    }
  }
  return path.reverse();
}

export function consistencyProof(source: NodeSource, first: number, second: number): Buffer[] {
  if (!Number.isInteger(first) || !Number.isInteger(second) || first < 1 || first > second) {
    throw new RangeError('tree sizes out of range');
  }
  if (first === second) {
    return [];
  }
  const path: Buffer[] = [];
  let start = 0;
  let length = second;
  let m = first;
  let complete = true;
  while (m !== length) {
    const split = largestPowerOfTwoBelow(length);
    if (m <= split) {
      path.push(subtreeHash(source, start + split, length - split));
      length = split;
    } else {
      path.push(subtreeHash(source, start, split));
      start += split;
      m -= split;
      length -= split;
      complete = false;
    }
  }
  if (!complete) {
    path.push(subtreeHash(source, start, length));
  }
  return path.reverse();
}

export function verifyInclusion(leafHash: Buffer, index: number, size: number, proof: Buffer[], root: Buffer): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size || size > MAX_TREE_SIZE) {
    return false;
  }
  let fn = index;
  let sn = size - 1;
  let r = leafHash;
  for (const p of proof) {
    if (sn === 0) {
      return false;
    }
    if (fn % 2 === 1 || fn === sn) {
      r = hashChildren(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = hashChildren(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && hashesEqual(r, root);
}

export function verifyConsistency(first: number, second: number, firstRoot: Buffer, secondRoot: Buffer, proof: Buffer[]): boolean {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 1 || first > second || second > MAX_TREE_SIZE) {
    return false;
  }
  if (first === second) {
    return proof.length === 0 && hashesEqual(firstRoot, secondRoot);
  }
  const nodes = isPowerOfTwo(first) ? [firstRoot, ...proof] : [...proof];
  const head = nodes[0];
  if (!head) {
    return false;
  }
  let fn = first - 1;
  let sn = second - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = head;
  let sr = head;
  for (const c of nodes.slice(1)) {
    if (sn === 0) {
      return false;
    }
    if (fn % 2 === 1 || fn === sn) {
      fr = hashChildren(c, fr);
      sr = hashChildren(c, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      sr = hashChildren(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && hashesEqual(fr, firstRoot) && hashesEqual(sr, secondRoot);
}

export interface PeakEntry {
  level: number;
  hash: Buffer;
}

export interface AppendResult {
  nodes: { level: number; index: number; hash: Buffer }[];
  peaks: PeakEntry[];
  size: number;
}

export function peakPositions(size: number): { level: number; index: number }[] {
  const peaks: { level: number; index: number }[] = [];
  for (let level = 48; level >= 0; level -= 1) {
    if (Math.floor(size / 2 ** level) % 2 === 1) {
      peaks.push({ level, index: Math.floor(size / 2 ** level) - 1 });
    }
  }
  return peaks;
}

export function appendLeaves(size: number, peaks: PeakEntry[], leafHashes: Buffer[]): AppendResult {
  const stack = peaks.map((peak) => ({ ...peak }));
  const nodes: AppendResult['nodes'] = [];
  let count = size;
  for (const leaf of leafHashes) {
    count += 1;
    nodes.push({ level: 0, index: count - 1, hash: leaf });
    let current: PeakEntry = { level: 0, hash: leaf };
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top || top.level !== current.level) {
        break;
      }
      stack.pop();
      current = { level: current.level + 1, hash: hashChildren(top.hash, current.hash) };
      nodes.push({ level: current.level, index: Math.floor(count / 2 ** current.level) - 1, hash: current.hash });
    }
    stack.push(current);
  }
  return { nodes, peaks: stack, size: count };
}

export function rootFromPeaks(peaks: PeakEntry[]): Buffer {
  const last = peaks[peaks.length - 1];
  if (!last) {
    return emptyRoot();
  }
  let acc = last.hash;
  for (let i = peaks.length - 2; i >= 0; i -= 1) {
    acc = hashChildren((peaks[i] as PeakEntry).hash, acc);
  }
  return acc;
}

export class MemoryNodeSource implements NodeSource {
  private readonly levels: Buffer[][] = [];

  constructor(leafHashes: Buffer[] = []) {
    this.add(leafHashes);
  }

  get size(): number {
    return this.levels[0]?.length ?? 0;
  }

  add(leafHashes: Buffer[]): void {
    const peaks = peakPositions(this.size).map(({ level, index }) => ({ level, hash: this.node(level, index) }));
    const { nodes } = appendLeaves(this.size, peaks, leafHashes);
    for (const { level, index, hash } of nodes) {
      (this.levels[level] ??= [])[index] = hash;
    }
  }

  node(level: number, index: number): Buffer {
    const hash = this.levels[level]?.[index];
    if (!hash) {
      throw new RangeError(`missing node ${level}/${index}`);
    }
    return hash;
  }
}

export class NodeCollector implements NodeSource {
  readonly requested = new Map<string, { level: number; index: number }>();

  node(level: number, index: number): Buffer {
    this.requested.set(`${level}/${index}`, { level, index });
    return Buffer.alloc(HASH_BYTES);
  }
}

export class MapNodeSource implements NodeSource {
  constructor(private readonly nodes: Map<string, Buffer>) {}

  node(level: number, index: number): Buffer {
    const hash = this.nodes.get(`${level}/${index}`);
    if (!hash) {
      throw new RangeError(`missing node ${level}/${index}`);
    }
    return hash;
  }
}
