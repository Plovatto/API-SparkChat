import type { Request, Response } from 'express';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { fetchProxiedImage } from './link-preview.image-proxy.js';
import type { LinkPreviewService } from './link-preview.service.js';

export const linkPreviewRequestSchema = z
  .object({ url: z.string().trim().url().max(2000) })
  .openapi('LinkPreviewRequest');

export const linkPreviewResponseSchema = z
  .object({
    url: z.string().openapi({ example: 'https://example.com/article' }),
    title: z.string().openapi({ example: 'Título do artigo' }),
    description: z.string().nullable().openapi({ example: 'Resumo do artigo.' }),
    imageUrl: z.string().nullable().openapi({ example: 'https://example.com/cover.jpg' }),
    siteName: z.string().nullable().openapi({ example: 'Example' }),
  })
  .openapi('LinkPreviewResponse');

export const linkPreviewImageQuerySchema = z.object({ url: z.string().trim().url().max(2000) });

export function createLinkPreviewController(service: LinkPreviewService) {
  return {
    async getPreview(req: Request, res: Response): Promise<void> {
      const parsed = linkPreviewRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: 'URL inválida.' });
        return;
      }

      const preview = await service.getPreview(parsed.data.url).catch(() => null);
      if (!preview) {
        res.status(422).json({ message: 'Não foi possível gerar um preview para essa URL.' });
        return;
      }

      res.status(200).json(preview);
    },

    async getImage(req: Request, res: Response): Promise<void> {
      const parsed = linkPreviewImageQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ message: 'URL inválida.' });
        return;
      }

      const image = await fetchProxiedImage(parsed.data.url).catch(() => null);
      if (!image) {
        res.status(422).json({ message: 'Não foi possível carregar essa imagem.' });
        return;
      }

      res.status(200).set('Content-Type', image.contentType).set('Cache-Control', 'public, max-age=86400').send(image.body);
    },
  };
}
