import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { errorResponseSchema } from '../../docs/common-schemas.js';
import { registry } from '../../docs/registry.js';
import { createMessageController, mediaUploadResponseSchema } from './message.controller.js';
import { audioUpload, imageUpload } from './message.upload.js';

function registerUploadPath(path: string, fieldName: 'image' | 'audio', summary: string, maxSizeDescription: string): void {
  registry.registerPath({
    method: 'post',
    path,
    tags: ['Messages'],
    summary,
    request: {
      body: {
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { [fieldName]: { type: 'string', format: 'binary' } },
              required: [fieldName],
            },
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Arquivo armazenado com sucesso',
        content: { 'application/json': { schema: mediaUploadResponseSchema } },
      },
      400: {
        description: maxSizeDescription,
        content: { 'application/json': { schema: errorResponseSchema } },
      },
    },
  });
}

registerUploadPath(
  '/api/messages/upload-image',
  'image',
  'Envia uma imagem e retorna sua URL para uso em uma mensagem do tipo image',
  'Nenhuma imagem enviada, tipo de arquivo inválido ou arquivo maior que 5MB',
);
registerUploadPath(
  '/api/messages/upload-audio',
  'audio',
  'Envia um áudio e retorna sua URL para uso em uma mensagem do tipo audio',
  'Nenhum áudio enviado, tipo de arquivo inválido ou arquivo maior que 8MB',
);

function createUploadErrorHandler(mediaLabel: string, maxSizeLabel: string, acceptedTypesLabel: string) {
  return function handleUploadError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
    if (!(err instanceof multer.MulterError)) {
      next(err);
      return;
    }

    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ message: `O ${mediaLabel} excede o tamanho máximo permitido de ${maxSizeLabel}.` });
      return;
    }

    res.status(400).json({ message: `Tipo de arquivo inválido. Envie ${mediaLabel} ${acceptedTypesLabel}.` });
  };
}

const handleImageUploadError = createUploadErrorHandler('imagem', '5MB', 'JPEG, PNG, GIF ou WEBP');
const handleAudioUploadError = createUploadErrorHandler('áudio', '8MB', 'WEBM, OGG, MP4, AAC, MPEG ou WAV');

export function createMessageRouter(): Router {
  const router = Router();
  const controller = createMessageController();

  router.post(
    '/upload-image',
    imageUpload.single('image'),
    handleImageUploadError,
    (req: Request, res: Response) => controller.uploadImage(req, res),
  );

  router.post(
    '/upload-audio',
    audioUpload.single('audio'),
    handleAudioUploadError,
    (req: Request, res: Response) => controller.uploadAudio(req, res),
  );

  return router;
}
