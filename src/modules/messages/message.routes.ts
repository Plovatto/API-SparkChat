import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { createMessageController, uploadImageResponseSchema } from './message.controller.js';
import { imageUpload } from './message.upload.js';

registry.registerPath({
  method: 'post',
  path: '/api/messages/upload-image',
  tags: ['Messages'],
  summary: 'Envia uma imagem e retorna sua URL para uso em uma mensagem do tipo image',
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: { image: { type: 'string', format: 'binary' } },
            required: ['image'],
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Imagem armazenada com sucesso',
      content: { 'application/json': { schema: uploadImageResponseSchema } },
    },
    400: {
      description: 'Nenhuma imagem enviada, tipo de arquivo inválido ou arquivo maior que 5MB',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

function handleUploadError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (!(err instanceof multer.MulterError)) {
    next(err);
    return;
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ message: 'A imagem excede o tamanho máximo permitido de 5MB.' });
    return;
  }

  res.status(400).json({ message: 'Tipo de arquivo inválido. Envie uma imagem JPEG, PNG, GIF ou WEBP.' });
}

export function createMessageRouter(): Router {
  const router = Router();
  const controller = createMessageController();

  router.post(
    '/upload-image',
    imageUpload.single('image'),
    handleUploadError,
    (req: Request, res: Response) => controller.uploadImage(req, res),
  );

  return router;
}
