export const SOCKET_MAX_HTTP_BUFFER_SIZE = 96 * 1024;

export const SOCKET_PER_MESSAGE_DEFLATE = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
} as const;
