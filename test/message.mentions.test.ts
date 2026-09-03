import { describe, expect, it } from 'vitest';
import { parseMentionedUserIds } from '../src/modules/messages/message.mentions.js';

const participants = [
  { id: 'alice-id', nickname: 'Alice' },
  { id: 'bob-id', nickname: 'Bob' },
];

describe('parseMentionedUserIds', () => {
  it('resolves a mentioned nickname to its user id', () => {
    expect(parseMentionedUserIds('Oi @Bob, tudo bem?', participants)).toEqual(['bob-id']);
  });

  it('matches case-insensitively', () => {
    expect(parseMentionedUserIds('oi @bob', participants)).toEqual(['bob-id']);
  });

  it('resolves multiple distinct mentions without duplicates', () => {
    const result = parseMentionedUserIds('@Alice e @Bob, e de novo @alice', participants);
    expect(result.sort()).toEqual(['alice-id', 'bob-id'].sort());
  });

  it('ignores @tokens that do not match any participant nickname', () => {
    expect(parseMentionedUserIds('mandei um email pra @ninguem', participants)).toEqual([]);
  });

  it('returns an empty array when there is no mention', () => {
    expect(parseMentionedUserIds('mensagem normal sem menção', participants)).toEqual([]);
  });
});
