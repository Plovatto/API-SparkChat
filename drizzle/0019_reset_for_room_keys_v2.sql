DELETE FROM `room_keys`;--> statement-breakpoint
DELETE FROM `room_bans`;--> statement-breakpoint
DELETE FROM `room_participants`;--> statement-breakpoint
DELETE FROM `messages`;--> statement-breakpoint
DELETE FROM `uploads`;--> statement-breakpoint
DELETE FROM `rooms`;--> statement-breakpoint
DELETE FROM `sessions`;--> statement-breakpoint
DELETE FROM `storage_usage`;--> statement-breakpoint
DELETE FROM `link_previews`;--> statement-breakpoint
DELETE FROM `users` WHERE `id` <> 'spark-ai';--> statement-breakpoint
DROP TABLE `room_keys`;--> statement-breakpoint
CREATE TABLE `room_keys` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`sealed_key` text NOT NULL,
	`sender_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `user_id`, `key_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_keys_user_id_idx` ON `room_keys` (`user_id`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `current_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `current_key_id` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `rotation_required` integer;
