export type { AvatarClientToServerEvents, AvatarServerToClientEvents } from './avatar.events.js';
export { MAX_AVATAR_UPLOAD_BYTES, MAX_PROFILE_KEY_ENVELOPE_LENGTH, MAX_PROFILE_KEY_ENVELOPES } from './avatar.limits.js';
export { AvatarRepository } from './avatar.repository.js';
export { createAvatarRouter } from './avatar.routes.js';
export { AvatarService } from './avatar.service.js';
export { registerAvatarSocketHandlers } from './avatar.socket.js';
