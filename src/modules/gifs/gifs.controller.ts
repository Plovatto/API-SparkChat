import type { Request, Response } from 'express';
import { z } from 'zod';
import '../../docs/zod-extend.js';
import { errorPayload } from '../../lib/app-error.js';
import { isAllowedGifMediaUrl } from './gifs.media-url.js';
import { GIF_LOCALES, type GifPage, type GifProvider } from './gifs.provider.js';

const pageSchema = z.number().int().min(1).max(50).optional().openapi({ example: 1, description: 'Página (1 a 50); padrão 1' });
const localeSchema = z.enum(GIF_LOCALES).optional().openapi({ example: 'br', description: 'Região dos resultados: br ou us' });

export const gifStatusResponseSchema = z
  .object({ enabled: z.boolean().openapi({ example: true }) })
  .openapi('GifStatusResponse');

export const gifTrendingRequestSchema = z
  .object({ page: pageSchema, locale: localeSchema })
  .strict()
  .openapi('GifTrendingRequest');

export const gifSearchRequestSchema = z
  .object({
    q: z.string().trim().min(1).max(100).openapi({ example: 'gato', description: 'Termo pesquisado (1 a 100 caracteres)' }),
    page: pageSchema,
    locale: localeSchema,
  })
  .strict()
  .openapi('GifSearchRequest');

export const gifMediaRequestSchema = z
  .object({ url: z.string().max(300).openapi({ example: 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/eUbp2uNc.webp' }) })
  .strict()
  .openapi('GifMediaRequest');

export const gifPageResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().openapi({ example: '6458236' }),
          title: z.string().openapi({ example: 'Happy Cat' }),
          url: z.string().openapi({ example: 'https://static.klipy.com/ii/935d7ab9d8c6202580a668421940ec81/14/af/eUbp2uNc.webp' }),
          width: z.number().int().openapi({ example: 220 }),
          height: z.number().int().openapi({ example: 164 }),
          size: z.number().int().openapi({ example: 117000, description: 'Tamanho em bytes informado pelo provedor' }),
        })
        .openapi('GifItem'),
    ),
    page: z.number().int().openapi({ example: 1 }),
    hasNext: z.boolean().openapi({ example: true }),
  })
  .openapi('GifPage');

function body(req: Request): unknown {
  return req.body ?? {};
}

export function createGifController(provider: GifProvider | null) {
  const sendPage = async (res: Response, pending: Promise<GifPage>): Promise<void> => {
    const page = await pending.catch(() => null);
    if (!page) {
      res.status(502).json(errorPayload('gifs.providerFailed'));
      return;
    }
    res.status(200).set('Cache-Control', 'no-store').json(page);
  };

  const status = (_req: Request, res: Response): void => {
    res.status(200).set('Cache-Control', 'no-store').json({ enabled: provider !== null });
  };

  const trending = async (req: Request, res: Response): Promise<void> => {
    if (!provider) {
      res.status(503).json(errorPayload('gifs.unavailable'));
      return;
    }
    const parsed = gifTrendingRequestSchema.safeParse(body(req));
    if (!parsed.success) {
      res.status(400).json(errorPayload('gifs.invalidQuery'));
      return;
    }
    await sendPage(res, provider.trending(parsed.data.page ?? 1, parsed.data.locale));
  };

  const search = async (req: Request, res: Response): Promise<void> => {
    if (!provider) {
      res.status(503).json(errorPayload('gifs.unavailable'));
      return;
    }
    const parsed = gifSearchRequestSchema.safeParse(body(req));
    if (!parsed.success) {
      res.status(400).json(errorPayload('gifs.invalidQuery'));
      return;
    }
    await sendPage(res, provider.search(parsed.data.q, parsed.data.page ?? 1, parsed.data.locale));
  };

  const media = async (req: Request, res: Response): Promise<void> => {
    if (!provider) {
      res.status(503).json(errorPayload('gifs.unavailable'));
      return;
    }
    const parsed = gifMediaRequestSchema.safeParse(body(req));
    if (!parsed.success || !isAllowedGifMediaUrl(parsed.data.url)) {
      res.status(400).json(errorPayload('gifs.invalidMediaUrl'));
      return;
    }
    const image = await provider.fetchMedia(parsed.data.url).catch(() => null);
    if (!image) {
      res.status(502).json(errorPayload('gifs.providerFailed'));
      return;
    }
    res
      .status(200)
      .set('Content-Type', image.contentType)
      .set('X-Content-Type-Options', 'nosniff')
      .set('Cache-Control', 'private, max-age=3600')
      .send(image.body);
  };

  return { status, trending, search, media };
}
