import type { Request, Response } from 'express';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { imageUrlPath } from '../../config/paths.js';

export const uploadImageResponseSchema = z
  .object({
    url: z.string().openapi({ example: '/uploads/images/3f1b2c.png', description: 'Caminho relativo da imagem enviada' }),
  })
  .openapi('UploadImageResponse');

export function createMessageController() {
  return {
    uploadImage(req: Request, res: Response): void {
      if (!req.file) {
        res.status(400).json({ message: 'Nenhuma imagem enviada.' });
        return;
      }

      res.status(201).json({ url: imageUrlPath(req.file.filename) });
    },
  };
}
