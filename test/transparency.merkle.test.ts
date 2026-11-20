import { describe, expect, it } from 'vitest';
import {
  appendLeaves,
  consistencyProof,
  emptyRoot,
  hashChildren,
  hashLeaf,
  inclusionProof,
  MemoryNodeSource,
  peakPositions,
  rootFromPeaks,
  rootHash,
  verifyConsistency,
  verifyInclusion,
} from '@/modules/transparency/transparency.merkle.js';

const RFC_LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f'].map((hex) =>
  Buffer.from(hex, 'hex'),
);

const RFC_ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

function naiveRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) {
    return emptyRoot();
  }
  if (leaves.length === 1) {
    return hashLeaf(leaves[0] as Buffer);
  }
  let k = 1;
  while (k * 2 < leaves.length) {
    k *= 2;
  }
  return hashChildren(naiveRoot(leaves.slice(0, k)), naiveRoot(leaves.slice(k)));
}

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function leafData(count: number): Buffer[] {
  return Array.from({ length: count }, (_, i) => Buffer.from(`leaf-${i}`));
}

describe('merkle tree hashing', () => {
  it('hashes the empty tree like RFC 6962', () => {
    expect(emptyRoot().toString('hex')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(rootHash(new MemoryNodeSource(), 0).toString('hex')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it.each(RFC_ROOTS.map((root, i) => [i + 1, root] as const))('matches the published root for the first %i RFC leaves', (size, expected) => {
    const source = new MemoryNodeSource(RFC_LEAVES.slice(0, size).map(hashLeaf));
    expect(rootHash(source, size).toString('hex')).toBe(expected);
    expect(naiveRoot(RFC_LEAVES.slice(0, size)).toString('hex')).toBe(expected);
  });

  it('keeps the root of every prefix stable while the tree grows', () => {
    const data = leafData(40);
    const source = new MemoryNodeSource(data.map(hashLeaf));
    for (let size = 1; size <= data.length; size += 1) {
      expect(rootHash(source, size).equals(naiveRoot(data.slice(0, size)))).toBe(true);
    }
  });

  it('derives the same root from the append peaks', () => {
    const data = leafData(37);
    let size = 0;
    let peaks: { level: number; hash: Buffer }[] = [];
    for (const leaf of data) {
      const result = appendLeaves(size, peaks, [hashLeaf(leaf)]);
      size = result.size;
      peaks = result.peaks;
      expect(rootFromPeaks(peaks).equals(naiveRoot(data.slice(0, size)))).toBe(true);
    }
    expect(peakPositions(37)).toEqual([
      { level: 5, index: 0 },
      { level: 2, index: 8 },
      { level: 0, index: 36 },
    ]);
  });

  it('appends in a batch exactly like one by one', () => {
    const data = leafData(21).map(hashLeaf);
    const single = new MemoryNodeSource();
    data.forEach((leaf) => single.add([leaf]));
    const batch = new MemoryNodeSource(data);
    expect(rootHash(batch, 21).equals(rootHash(single, 21))).toBe(true);
  });
});

describe('inclusion proofs', () => {
  it('matches the RFC 6962 proof for leaf 0 of an eight leaf tree', () => {
    const source = new MemoryNodeSource(RFC_LEAVES.map(hashLeaf));
    const proof = inclusionProof(source, 0, 8).map((h) => h.toString('hex'));
    expect(proof).toEqual([
      '96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7',
      '5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
      '6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4',
    ]);
  });

  it('verifies every leaf of every tree size up to 70', () => {
    const data = leafData(70);
    const hashes = data.map(hashLeaf);
    const source = new MemoryNodeSource(hashes);
    for (let size = 1; size <= 70; size += 1) {
      const root = rootHash(source, size);
      for (let index = 0; index < size; index += 1) {
        const proof = inclusionProof(source, index, size);
        expect(verifyInclusion(hashes[index] as Buffer, index, size, proof, root)).toBe(true);
      }
    }
  });

  it('verifies randomized large trees', () => {
    const random = lcg(7);
    const hashes = leafData(2000).map(hashLeaf);
    const source = new MemoryNodeSource(hashes);
    for (let round = 0; round < 200; round += 1) {
      const size = 1 + Math.floor(random() * 2000);
      const index = Math.floor(random() * size);
      const root = rootHash(source, size);
      expect(verifyInclusion(hashes[index] as Buffer, index, size, inclusionProof(source, index, size), root)).toBe(true);
    }
  });

  describe('tampering', () => {
    const hashes = leafData(13).map(hashLeaf);
    const source = new MemoryNodeSource(hashes);
    const root = rootHash(source, 13);
    const proof = inclusionProof(source, 6, 13);

    it('rejects a different leaf', () => {
      expect(verifyInclusion(hashLeaf(Buffer.from('other')), 6, 13, proof, root)).toBe(false);
    });

    it('rejects a wrong index, size or root', () => {
      expect(verifyInclusion(hashes[6] as Buffer, 7, 13, proof, root)).toBe(false);
      expect(verifyInclusion(hashes[6] as Buffer, 6, 13, proof, rootHash(source, 12))).toBe(false);
      expect(verifyInclusion(hashes[6] as Buffer, 13, 13, proof, root)).toBe(false);
      expect(verifyInclusion(hashes[6] as Buffer, -1, 13, proof, root)).toBe(false);
    });

    it('rejects a flipped bit, a truncated and an extended proof', () => {
      const flipped = proof.map((h) => Buffer.from(h));
      (flipped[1] as Buffer)[0] = (flipped[1] as Buffer)[0]! ^ 1;
      expect(verifyInclusion(hashes[6] as Buffer, 6, 13, flipped, root)).toBe(false);
      expect(verifyInclusion(hashes[6] as Buffer, 6, 13, proof.slice(1), root)).toBe(false);
      expect(verifyInclusion(hashes[6] as Buffer, 6, 13, [...proof, Buffer.alloc(32)], root)).toBe(false);
    });

    it('rejects the empty proof for a multi leaf tree', () => {
      expect(verifyInclusion(hashes[6] as Buffer, 6, 13, [], root)).toBe(false);
    });
  });
});

describe('consistency proofs', () => {
  it('matches the RFC 6962 consistency proof between sizes 6 and 8', () => {
    const source = new MemoryNodeSource(RFC_LEAVES.map(hashLeaf));
    const proof = consistencyProof(source, 6, 8).map((h) => h.toString('hex'));
    expect(proof).toEqual([
      '0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a',
      'ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0',
      'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
    ]);
  });

  it('verifies every pair of sizes up to 40', () => {
    const hashes = leafData(40).map(hashLeaf);
    const source = new MemoryNodeSource(hashes);
    for (let second = 1; second <= 40; second += 1) {
      for (let first = 1; first <= second; first += 1) {
        const proof = consistencyProof(source, first, second);
        expect(verifyConsistency(first, second, rootHash(source, first), rootHash(source, second), proof)).toBe(true);
      }
    }
  });

  it('verifies randomized large trees', () => {
    const random = lcg(99);
    const source = new MemoryNodeSource(leafData(3000).map(hashLeaf));
    for (let round = 0; round < 200; round += 1) {
      const second = 1 + Math.floor(random() * 3000);
      const first = 1 + Math.floor(random() * second);
      const proof = consistencyProof(source, first, second);
      expect(verifyConsistency(first, second, rootHash(source, first), rootHash(source, second), proof)).toBe(true);
    }
  });

  describe('tampering', () => {
    const honest = new MemoryNodeSource(leafData(20).map(hashLeaf));
    const rootAt = (size: number) => rootHash(honest, size);

    it('rejects a forked history', () => {
      const forked = new MemoryNodeSource(leafData(20).map(hashLeaf));
      const forkData = leafData(20);
      forkData[3] = Buffer.from('rewritten');
      const fork = new MemoryNodeSource(forkData.map(hashLeaf));
      const proof = consistencyProof(fork, 9, 20);
      expect(verifyConsistency(9, 20, rootAt(9), rootHash(fork, 20), proof)).toBe(false);
      expect(verifyConsistency(9, 20, rootHash(forked, 9), rootHash(forked, 20), consistencyProof(forked, 9, 20))).toBe(true);
    });

    it('rejects a proof for different sizes, a rolled back order and wrong roots', () => {
      const proof = consistencyProof(honest, 9, 20);
      expect(verifyConsistency(9, 19, rootAt(9), rootAt(19), proof)).toBe(false);
      expect(verifyConsistency(10, 20, rootAt(10), rootAt(20), proof)).toBe(false);
      expect(verifyConsistency(20, 9, rootAt(20), rootAt(9), proof)).toBe(false);
      expect(verifyConsistency(9, 20, rootAt(8), rootAt(20), proof)).toBe(false);
      expect(verifyConsistency(0, 20, rootAt(1), rootAt(20), [])).toBe(false);
    });

    it('rejects a flipped bit, a truncated and an extended proof', () => {
      const proof = consistencyProof(honest, 9, 20);
      const flipped = proof.map((h) => Buffer.from(h));
      (flipped[0] as Buffer)[5] = (flipped[0] as Buffer)[5]! ^ 0x80;
      expect(verifyConsistency(9, 20, rootAt(9), rootAt(20), flipped)).toBe(false);
      expect(verifyConsistency(9, 20, rootAt(9), rootAt(20), proof.slice(0, -1))).toBe(false);
      expect(verifyConsistency(9, 20, rootAt(9), rootAt(20), [...proof, Buffer.alloc(32)])).toBe(false);
    });

    it('requires an empty proof for equal sizes and equal roots', () => {
      expect(verifyConsistency(20, 20, rootAt(20), rootAt(20), [])).toBe(true);
      expect(verifyConsistency(20, 20, rootAt(20), rootAt(19), [])).toBe(false);
      expect(verifyConsistency(20, 20, rootAt(20), rootAt(20), [Buffer.alloc(32)])).toBe(false);
    });
  });
});
