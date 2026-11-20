import { logger } from '../../config/logger.js';
import { AppError } from '../../lib/app-error.js';
import { resolveAvatarObjectKey } from '../../storage/object-storage-url.js';
import type { ObjectStorage } from '../../storage/object-storage.js';
import type { StorageQuota } from '../../storage/storage-quota.js';
import type { UploadRegistry } from '../../storage/upload-registry.js';
import type { AvatarRepository, ProfileKeyWrite } from './avatar.repository.js';

export interface SetUserAvatarInput {
  url: string;
  encryptedAvatar: string;
  profileKeyVersion: number;
}

export interface SetRoomAvatarInput {
  roomId: string;
  url: string;
  encryptedAvatar: string;
  keyId: string;
}

export interface UserAvatarView {
  userId: string;
  encryptedAvatar: string | null;
  profileKeyVersion: number;
}

export interface RoomAvatarView {
  roomId: string;
  encryptedAvatar: string | null;
  keyId: string | null;
}

export interface ProfileKeysView {
  roomId: string;
  keyId: string;
  envelopes: Record<string, string>;
}

const USER_AVATAR_ERRORS = {
  notFound: 'user.notFound',
  staleVersion: 'user.profileKeyVersionStale',
  invalidUpload: 'user.avatarUploadInvalid',
} as const;

export class AvatarService {
  constructor(
    private readonly repository: AvatarRepository,
    private readonly uploads: UploadRegistry,
    private readonly objectStorage: ObjectStorage,
    private readonly storageQuota: StorageQuota,
  ) {}

  private resolveUploadKey(url: string): string | null {
    const key = resolveAvatarObjectKey(url);
    return key && url.split('?')[0] === this.objectStorage.publicUrl(key) ? key : null;
  }

  async setUserAvatar(userId: string, input: SetUserAvatarInput): Promise<UserAvatarView> {
    const uploadKey = this.resolveUploadKey(input.url);
    if (!uploadKey) {
      throw AppError.of('user.avatarUploadInvalid');
    }

    const outcome = await this.repository.setUserAvatar({
      userId,
      uploadKey,
      encryptedAvatar: input.encryptedAvatar,
      profileKeyVersion: input.profileKeyVersion,
    });
    if (outcome.status !== 'updated') {
      throw AppError.of(USER_AVATAR_ERRORS[outcome.status]);
    }

    await this.discardReplaced(outcome.previousUploadKey, uploadKey);
    return { userId, encryptedAvatar: input.encryptedAvatar, profileKeyVersion: input.profileKeyVersion };
  }

  async clearUserAvatar(userId: string): Promise<UserAvatarView> {
    const cleared = await this.repository.clearUserAvatar(userId);
    if (!cleared) {
      throw AppError.of('user.notFound');
    }

    await this.discardReplaced(cleared.previousUploadKey, null);
    return { userId, encryptedAvatar: null, profileKeyVersion: cleared.profileKeyVersion };
  }

  async setRoomAvatar(userId: string, input: SetRoomAvatarInput): Promise<RoomAvatarView> {
    const uploadKey = this.resolveUploadKey(input.url);
    if (!uploadKey) {
      throw AppError.of('room.avatarUploadInvalid');
    }

    const outcome = await this.repository.setRoomAvatar({
      roomId: input.roomId,
      userId,
      keyId: input.keyId,
      uploadKey,
      encryptedAvatar: input.encryptedAvatar,
    });
    switch (outcome.status) {
      case 'notFound':
        throw AppError.of('room.notFound');
      case 'stale':
        throw AppError.of('e2e.avatarKeyStale');
      case 'notInRoster':
        throw AppError.of('e2e.avatarRequiresRoster');
      case 'invalidUpload':
        throw AppError.of('room.avatarUploadInvalid');
      case 'updated':
        break;
    }

    await this.discardReplaced(outcome.previousUploadKey, uploadKey);
    return { roomId: input.roomId, encryptedAvatar: input.encryptedAvatar, keyId: input.keyId };
  }

  async clearRoomAvatar(userId: string, roomId: string): Promise<RoomAvatarView> {
    const outcome = await this.repository.clearRoomAvatar(roomId, userId);
    if (outcome.status !== 'cleared') {
      throw AppError.of(outcome.status === 'notFound' ? 'room.notFound' : 'e2e.avatarRequiresRoster');
    }

    await this.discardReplaced(outcome.previousUploadKey, null);
    return { roomId, encryptedAvatar: null, keyId: null };
  }

  async publishProfileKey(userId: string, input: { roomId: string; keyId: string; envelope: string }): Promise<ProfileKeysView> {
    const outcome = await this.repository.publishProfileKey(input.roomId, userId, input.keyId, input.envelope);
    return this.toProfileKeysView(input.roomId, input.keyId, outcome);
  }

  async rewrapProfileKeys(userId: string, input: { roomId: string; keyId: string; envelopes: Record<string, string> }): Promise<ProfileKeysView> {
    const outcome = await this.repository.rewrapProfileKeys(input.roomId, userId, input.keyId, input.envelopes);
    return this.toProfileKeysView(input.roomId, input.keyId, outcome);
  }

  private toProfileKeysView(roomId: string, keyId: string, outcome: ProfileKeyWrite): ProfileKeysView {
    switch (outcome.status) {
      case 'notFound':
        throw AppError.of('room.notFound');
      case 'stale':
        throw AppError.of('e2e.profileKeyStale');
      case 'notMember':
        throw AppError.of('room.notMember');
      case 'written':
        return { roomId, keyId, envelopes: outcome.envelopes };
    }
  }

  private async discardReplaced(previousUploadKey: string | null, currentUploadKey: string | null): Promise<void> {
    if (!previousUploadKey || previousUploadKey === currentUploadKey) {
      return;
    }

    try {
      const size = await this.uploads.removeUnreferencedAvatar(previousUploadKey);
      if (size === null) {
        return;
      }
      await this.objectStorage.deleteObject(previousUploadKey);
      await this.storageQuota.releaseUsage(size);
    } catch (error) {
      logger.error({ err: error, key: previousUploadKey }, 'Failed to remove a replaced avatar upload');
    }
  }
}
