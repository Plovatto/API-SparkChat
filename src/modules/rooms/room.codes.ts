import { randomInt } from 'node:crypto';

const ROOM_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const ROOM_CODE_LENGTH = 10;

export function generateRoomCode(): string {
  let code = '';

  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_CHARS.charAt(randomInt(ROOM_CODE_CHARS.length));
  }

  return code;
}
