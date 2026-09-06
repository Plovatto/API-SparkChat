interface SignatureRule {
  offset: number;
  bytes: number[];
}

const RIFF_HEADER: SignatureRule = { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] };

const SIGNATURES: Record<string, SignatureRule[][]> = {
  'application/pdf': [[{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }]],
  'video/webm': [[{ offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }]],
  'video/mp4': [[{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }]],
  'video/quicktime': [[{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }]],
  'video/x-msvideo': [[RIFF_HEADER, { offset: 8, bytes: [0x41, 0x56, 0x49, 0x20] }]],
  'application/zip': [
    [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
    [{ offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] }],
  ],
  'application/x-zip-compressed': [[{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }]],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
  ],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
  ],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': [
    [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
  ],
  'application/msword': [[{ offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }]],
  'application/vnd.ms-excel': [[{ offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }]],
  'application/vnd.ms-powerpoint': [[{ offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }]],
  'image/jpeg': [[{ offset: 0, bytes: [0xff, 0xd8, 0xff] }]],
  'image/png': [[{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }]],
  'image/gif': [[{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }]],
  'image/webp': [[RIFF_HEADER, { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }]],
  'audio/webm': [[{ offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }]],
  'audio/ogg': [[{ offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53] }]],
  'audio/mp4': [[{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }]],
  'audio/aac': [[{ offset: 0, bytes: [0xff, 0xf1] }], [{ offset: 0, bytes: [0xff, 0xf9] }]],
  'audio/mpeg': [
    [{ offset: 0, bytes: [0x49, 0x44, 0x33] }],
    [{ offset: 0, bytes: [0xff, 0xfb] }],
    [{ offset: 0, bytes: [0xff, 0xf3] }],
    [{ offset: 0, bytes: [0xff, 0xf2] }],
  ],
  'audio/wav': [[RIFF_HEADER, { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] }]],
  'audio/x-wav': [[RIFF_HEADER, { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45] }]],
};

const NO_SIGNATURE_MIME_TYPES = new Set(['text/plain', 'text/csv']);
const SNIFF_LENGTH = 32;

function matchesRuleSet(buffer: Buffer, rules: SignatureRule[]): boolean {
  return rules.every((rule) => rule.bytes.every((byte, index) => buffer[rule.offset + index] === byte));
}

export function verifyFileSignature(buffer: Buffer, mimeType: string): boolean {
  const leading = buffer.subarray(0, SNIFF_LENGTH);

  if (NO_SIGNATURE_MIME_TYPES.has(mimeType)) {
    return !leading.includes(0);
  }

  const ruleSets = SIGNATURES[mimeType];
  if (!ruleSets) {
    return false;
  }

  return ruleSets.some((rules) => matchesRuleSet(leading, rules));
}
