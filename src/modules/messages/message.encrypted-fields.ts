export const ENCRYPTED_FIELD_PREFIX = 'e2e:v2:';

const NONCE_BYTES = 24;
const AEAD_TAG_BYTES = 16;
const SIGNATURE_BYTES = 64;
const MIN_BODY_LENGTH = Math.ceil(((NONCE_BYTES + AEAD_TAG_BYTES + SIGNATURE_BYTES) * 4) / 3);
const ENCRYPTED_FIELD_PATTERN = /^e2e:v2:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]+)$/;

export interface EncryptedMessageFields {
  type: 'text' | 'image' | 'audio' | 'file';
  content: string;
  caption?: string | undefined;
  assistantCard?: string | undefined;
  fileMeta?:
    | {
        name: string;
        mimeType: string;
        key?: string | undefined;
        thumbnailKey?: string | undefined;
        previewKey?: string | undefined;
      }
    | undefined;
  linkPreview?:
    | { url: string; title: string; description: string | null; imageUrl: string | null; siteName: string | null }
    | undefined;
}

export function readEncryptedFieldKeyId(value: string): string | null {
  const match = ENCRYPTED_FIELD_PATTERN.exec(value);
  if (!match?.[1] || !match[2] || match[2].length < MIN_BODY_LENGTH || match[2].length % 4 === 1) {
    return null;
  }
  return match[1];
}

function encryptedValues(fields: EncryptedMessageFields): string[] {
  const values: (string | null | undefined)[] = [
    fields.type === 'text' ? fields.content : undefined,
    fields.caption,
    fields.assistantCard,
    fields.fileMeta?.name,
    fields.fileMeta?.mimeType,
    fields.fileMeta?.key,
    fields.fileMeta?.thumbnailKey,
    fields.fileMeta?.previewKey,
    fields.linkPreview?.url,
    fields.linkPreview?.title,
    fields.linkPreview?.description,
    fields.linkPreview?.imageUrl,
    fields.linkPreview?.siteName,
  ];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function resolveMessageKeyId(fields: EncryptedMessageFields): string | null {
  const values = encryptedValues(fields);
  if (values.length === 0) {
    return null;
  }

  const keyIds = new Set(values.map(readEncryptedFieldKeyId));
  if (keyIds.size !== 1) {
    return null;
  }

  const [keyId] = keyIds;
  return keyId ?? null;
}
