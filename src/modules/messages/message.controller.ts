import { rm } from 'node:fs/promises';
import type { Request, Response } from 'express';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { audioUrlPath, fileUrlPath, imageUrlPath } from '../../config/paths.js';
import { verifyFileSignature } from './message.file-signature.js';

const INVALID_CONTENT_MESSAGE = 'O conteúdo do arquivo não corresponde ao tipo declarado.';

function decodeOriginalFilename(originalname: string): string {
  return Buffer.from(originalname, 'latin1').toString('utf8');
}

function isEncryptedUpload(req: Request): boolean {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>).encrypted === '1';
}

function withEncryptedMarker(url: string, encrypted: boolean): string {
  return encrypted ? `${url}?e2e=1` : url;
}

export const mediaUploadResponseSchema = z
  .object({
    url: z.string().openapi({ example: '/uploads/images/3f1b2c.png', description: 'Caminho relativo do arquivo enviado' }),
    mimeType: z.string().openapi({ example: 'image/png' }),
  })
  .openapi('MediaUploadResponse');

export const fileUploadResponseSchema = z
  .object({
    url: z.string().openapi({ example: '/uploads/files/3f1b2c.pdf', description: 'Caminho relativo do arquivo enviado' }),
    name: z.string().openapi({ example: 'relatorio.pdf', description: 'Nome original do arquivo' }),
    mimeType: z.string().openapi({ example: 'application/pdf' }),
    size: z.number().int().nonnegative().openapi({ example: 204800, description: 'Tamanho em bytes' }),
  })
  .openapi('FileUploadResponse');

interface UploadHandlerOptions<TResponse> {
  missingFileMessage: string;
  buildUrl: (filename: string) => string;
  buildResponse: (file: Express.Multer.File, url: string) => TResponse;
}

function createUploadHandler<TResponse>({ missingFileMessage, buildUrl, buildResponse }: UploadHandlerOptions<TResponse>) {
  return async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ message: missingFileMessage });
      return;
    }

    const encrypted = isEncryptedUpload(req);
    if (!encrypted && !(await verifyFileSignature(file.path, file.mimetype))) {
      await rm(file.path, { force: true });
      res.status(400).json({ message: INVALID_CONTENT_MESSAGE });
      return;
    }

    res.status(201).json(buildResponse(file, withEncryptedMarker(buildUrl(file.filename), encrypted)));
  };
}

export function createMessageController() {
  return {
    uploadImage: createUploadHandler({
      missingFileMessage: 'Nenhuma imagem enviada.',
      buildUrl: imageUrlPath,
      buildResponse: (file, url) => ({ url, mimeType: file.mimetype }),
    }),
    uploadAudio: createUploadHandler({
      missingFileMessage: 'Nenhum áudio enviado.',
      buildUrl: audioUrlPath,
      buildResponse: (file, url) => ({ url, mimeType: file.mimetype }),
    }),
    uploadFile: createUploadHandler({
      missingFileMessage: 'Nenhum arquivo enviado.',
      buildUrl: fileUrlPath,
      buildResponse: (file, url) => ({
        url,
        name: decodeOriginalFilename(file.originalname),
        mimeType: file.mimetype,
        size: file.size,
      }),
    }),
  };
}
