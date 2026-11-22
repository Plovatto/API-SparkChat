import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { describe, expect, it, vi } from 'vitest';
import { createUploadErrorHandler } from '@/modules/messages/upload-errors.js';

function fakeResponse() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { status } as unknown as Response, status, json };
}

function run(handler: ReturnType<typeof createUploadErrorHandler>, err: unknown) {
  const { res, status, json } = fakeResponse();
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  handler(err, {} as Request, res, next);
  return { status, json, next };
}

describe('createUploadErrorHandler', () => {
  it('passes errors that are not from multer to the next handler', () => {
    const error = new Error('boom');
    const { status, next } = run(createUploadErrorHandler('image', '5MB'), error);

    expect(next).toHaveBeenCalledWith(error);
    expect(status).not.toHaveBeenCalled();
  });

  it('answers an oversized file with the size limit of its kind', () => {
    const { status, json } = run(createUploadErrorHandler('audio', '8MB'), new multer.MulterError('LIMIT_FILE_SIZE', 'audio'));

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'upload.tooLarge', params: { kind: 'audio', maxSize: '8MB' } }));
  });

  it('uses the override code for an oversized file when one is given', () => {
    const handler = createUploadErrorHandler('gif', '2MB', { oversizeCode: 'upload.invalidGifSize' });
    const { json } = run(handler, new multer.MulterError('LIMIT_FILE_SIZE', 'gif'));

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'upload.invalidGifSize' }));
  });

  it('answers any other multer error as an invalid type of its kind', () => {
    const { status, json } = run(createUploadErrorHandler('avatar', '512KB'), new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'image'));

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'upload.invalidType', params: { kind: 'avatar' } }));
  });
});
