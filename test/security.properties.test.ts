import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseMentionedUserIds } from '@/modules/messages/message.mentions.js';
import { isUploadedMediaUrl } from '@/modules/messages/message.socket.js';
import { resolveObjectKey } from '@/storage/object-storage-url.js';

const mediaFolder = fc.constantFrom('images', 'audio', 'files');
const fileName = fc.stringMatching(/^[a-z0-9-]{1,24}\.[a-z0-9]{1,4}$/);

describe('isUploadedMediaUrl properties', () => {
  it('accepts every https url inside the uploaded-media namespace', () => {
    fc.assert(
      fc.property(fc.domain(), mediaFolder, fileName, (domain, folder, name) => {
        expect(isUploadedMediaUrl(`https://${domain}/uploads/${folder}/${name}`)).toBe(true);
      }),
    );
  });

  it('rejects every url that does not use https', () => {
    fc.assert(
      fc.property(fc.constantFrom('http:', 'javascript:', 'data:', 'file:', 'ftp:'), mediaFolder, fileName, (scheme, folder, name) => {
        expect(isUploadedMediaUrl(`${scheme}//cdn.test/uploads/${folder}/${name}`)).toBe(false);
        expect(isUploadedMediaUrl(`${scheme}/uploads/${folder}/${name}`)).toBe(false);
      }),
    );
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(typeof isUploadedMediaUrl(input)).toBe('boolean');
      }),
    );
  });
});

describe('resolveObjectKey properties', () => {
  it('only resolves keys inside the uploaded-media namespace', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        const key = resolveObjectKey(url);
        if (key !== null) {
          expect(key).toMatch(/^uploads\/(images|audio|files)\/[^/]+$/);
        }
      }),
    );
  });
});

describe('parseMentionedUserIds properties', () => {
  it('only returns ids of participants, without duplicates', () => {
    const participant = fc.record({ id: fc.uuid(), nickname: fc.stringMatching(/^[a-z0-9_]{1,12}$/) });

    fc.assert(
      fc.property(fc.string(), fc.array(participant, { maxLength: 5 }), (content, members) => {
        const ids = parseMentionedUserIds(content, members);
        const memberIds = new Set(members.map((member) => member.id));

        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => memberIds.has(id))).toBe(true);
      }),
    );
  });
});
