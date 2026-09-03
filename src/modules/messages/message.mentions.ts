const MENTION_PATTERN = /@([\p{L}\p{N}_]+)/gu;

export function parseMentionedUserIds(content: string, participants: { id: string; nickname: string }[]): string[] {
  const nicknameToId = new Map(participants.map((participant) => [participant.nickname.toLowerCase(), participant.id]));
  const matches = content.match(MENTION_PATTERN) ?? [];
  const mentioned = new Set<string>();

  for (const match of matches) {
    const id = nicknameToId.get(match.slice(1).toLowerCase());
    if (id) {
      mentioned.add(id);
    }
  }

  return [...mentioned];
}
