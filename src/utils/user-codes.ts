export function generateChatCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

export function generateLoginCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function isValidLoginCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}
