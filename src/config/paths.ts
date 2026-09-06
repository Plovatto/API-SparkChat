export const uploadedMediaKeyPrefix = 'uploads';

export function imageObjectKey(filename: string): string {
  return `${uploadedMediaKeyPrefix}/images/${filename}`;
}

export function audioObjectKey(filename: string): string {
  return `${uploadedMediaKeyPrefix}/audio/${filename}`;
}

export function fileObjectKey(filename: string): string {
  return `${uploadedMediaKeyPrefix}/files/${filename}`;
}
