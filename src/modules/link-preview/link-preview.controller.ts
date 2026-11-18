import type { Request, Response } from 'express';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { errorPayload } from '../../lib/app-error.js';
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

export function createLinkPreviewController(service: LinkPreviewService) {
  const getPreview = async (req: Request, res: Response): Promise<void> => {
    const parsed = linkPreviewRequestSchema.safeParse(req.body);
    const userId = req.authenticatedUser?.id;
    if (!parsed.success || !userId) {
      res.status(400).json(errorPayload('linkPreview.invalidUrl'));
      return;
    }

    const preview = await service.getPreview(userId, parsed.data.url).catch(() => null);
    if (!preview) {
      res.status(422).json(errorPayload('linkPreview.unavailable'));
      return;
    }

    res.status(200).set('Cache-Control', 'no-store').json(preview);
  };

  const getImage = async (req: Request, res: Response): Promise<void> => {
    const parsed = linkPreviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorPayload('linkPreview.invalidUrl'));
      return;
    }

    const image = await fetchProxiedImage(parsed.data.url).catch(() => null);
    if (!image) {
      res.status(422).json(errorPayload('linkPreview.imageUnavailable'));
      return;
    }

    res.status(200).set('Content-Type', image.contentType).set('Cache-Control', 'private, no-store').send(image.body);
  };

  return { getPreview, getImage };
}
