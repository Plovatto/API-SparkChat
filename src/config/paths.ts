import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(currentDir, '../..');

export const dataDir = path.join(rootDir, 'data');

export function dataFilePath(entity: string): string {
  return path.join(dataDir, `${entity}.json`);
}

export const uploadsDir = path.join(rootDir, 'uploads');
export const imagesUploadDir = path.join(uploadsDir, 'images');
export const uploadsUrlPrefix = '/uploads';

export function imageUrlPath(filename: string): string {
  return `${uploadsUrlPrefix}/images/${filename}`;
}
