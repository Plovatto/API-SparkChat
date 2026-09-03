import { rm } from 'node:fs/promises';
import type { Request, Response } from 'express';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { audioUrlPath, fileUrlPath, imageUrlPath } from '../../config/paths.js';
import { verifyFileSignature } from './message.file-signature.js';

function decodeOriginalFilename(originalname: string): string {
  return Buffer.from(originalname, 'latin1').toString('utf8');
}

export const mediaUploadResponseSchema = z
  .object({
    url: z.string().openapi({ example: '/uploads/images/3f1b2c.png', description: 'Caminho relativo do arquivo enviado' }),
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

export function createMessageController() {
  return {
    uploadImage(req: Request, res: Response): void {
      if (!req.file) {
        res.status(400).json({ message: 'Nenhuma imagem enviada.' });
        return;
      }

      res.status(201).json({ url: imageUrlPath(req.file.filename) });
    },

    uploadAudio(req: Request, res: Response): void {
      if (!req.file) {
        res.status(400).json({ message: 'Nenhum áudio enviado.' });
        return;
      }

      res.status(201).json({ url: audioUrlPath(req.file.filename) });
    },

    async uploadFile(req: Request, res: Response): Promise<void> {
      if (!req.file) {
        res.status(400).json({ message: 'Nenhum arquivo enviado.' });
        return;
      }

      const isValid = await verifyFileSignature(req.file.path, req.file.mimetype);
      if (!isValid) {
        await rm(req.file.path, { force: true });
        res.status(400).json({ message: 'O conteúdo do arquivo não corresponde ao tipo declarado.' });
        return;
      }

      res.status(201).json({
        url: fileUrlPath(req.file.filename),
        name: decodeOriginalFilename(req.file.originalname),
        mimeType: req.file.mimetype,
        size: req.file.size,
      });
    },
  };
}
