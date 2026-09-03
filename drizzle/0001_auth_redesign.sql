DELETE FROM `room_participants`;
--> statement-breakpoint
DELETE FROM `messages`;
--> statement-breakpoint
DELETE FROM `rooms`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`nickname` text NOT NULL,
	`nickname_normalized` text NOT NULL,
	`avatar` integer NOT NULL,
	`password_hash` text NOT NULL,
	`recovery_token_hash` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`created_at` text NOT NULL,
	`last_seen` text NOT NULL,
	`theme_base_theme` text,
	`theme_color_theme` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_nickname_normalized_unique` ON `users` (`nickname_normalized`);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);
