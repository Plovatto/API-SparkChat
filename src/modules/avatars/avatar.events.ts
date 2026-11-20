export interface UserAvatarUpdatedPayload {
  userId: string;
  encryptedAvatar: string | null;
  profileKeyVersion: number;
}

export interface RoomAvatarUpdatedPayload {
  roomId: string;
  encryptedAvatar: string | null;
  keyId: string | null;
}

export interface ProfileKeysUpdatedPayload {
  roomId: string;
  keyId: string;
  envelopes: Record<string, string>;
}

export interface AvatarClientToServerEvents {
  'user:set-avatar': (payload: { url: string; encryptedAvatar: string; profileKeyVersion: number }) => void;
  'user:clear-avatar': (payload?: Record<string, never>) => void;
  'room:set-avatar': (payload: { roomId: string; url: string; encryptedAvatar: string; keyId: string }) => void;
  'room:clear-avatar': (payload: { roomId: string }) => void;
  'room:publish-profile-key': (payload: { roomId: string; keyId: string; envelope: string }) => void;
  'room:rewrap-profile-keys': (payload: { roomId: string; keyId: string; envelopes: Record<string, string> }) => void;
}

export interface AvatarServerToClientEvents {
  'user:avatar-updated': (payload: UserAvatarUpdatedPayload) => void;
  'room:avatar-updated': (payload: RoomAvatarUpdatedPayload) => void;
  'room:profile-keys-updated': (payload: ProfileKeysUpdatedPayload) => void;
}
