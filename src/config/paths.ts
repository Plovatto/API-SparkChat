import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '../..');

export const uploadsDir = path.join(rootDir, 'uploads');
export const imagesUploadDir = path.join(uploadsDir, 'images');
export const audioUploadDir = path.join(uploadsDir, 'audio');
export const filesUploadDir = path.join(uploadsDir, 'files');
export const uploadsUrlPrefix = '/uploads';

export function imageUrlPath(filename: string): string {
  return `${uploadsUrlPrefix}/images/${filename}`;
}

export function audioUrlPath(filename: string): string {
  return `${uploadsUrlPrefix}/audio/${filename}`;
}

export function fileUrlPath(filename: string): string {
  return `${uploadsUrlPrefix}/files/${filename}`;
}
