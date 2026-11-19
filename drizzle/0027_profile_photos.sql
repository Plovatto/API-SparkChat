ALTER TABLE `room_participants` ADD `profile_key_envelope` text;--> statement-breakpoint
ALTER TABLE `room_participants` ADD `profile_key_key_id` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `encrypted_avatar` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `avatar_key_id` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `avatar_upload_key` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `avatar_owner` text;--> statement-breakpoint
CREATE INDEX `uploads_avatar_owner_idx` ON `uploads` (`avatar_owner`);--> statement-breakpoint
ALTER TABLE `users` ADD `encrypted_avatar` text;--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_upload_key` text;--> statement-breakpoint
ALTER TABLE `users` ADD `profile_key_version` integer DEFAULT 1 NOT NULL;