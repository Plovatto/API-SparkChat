CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`content` text NOT NULL,
	`type` text NOT NULL,
	`duration` integer,
	`timestamp` text NOT NULL,
	`deleted_for_everyone` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`delivered_to` text NOT NULL,
	`read_by` text NOT NULL,
	`played_by` text NOT NULL,
	`reply_to_snapshot` text
);
--> statement-breakpoint
CREATE INDEX `messages_room_id_timestamp_idx` ON `messages` (`room_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `room_participants` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`is_visible` integer DEFAULT true NOT NULL,
	`blocked_at` text,
	`blocked_by_user_id` text,
	`deleted_at` text,
	`reactivated_at` text,
	`joined_at` text,
	PRIMARY KEY(`room_id`, `user_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_participants_user_id_idx` ON `room_participants` (`user_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`room_code` text,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_room_code_unique` ON `rooms` (`room_code`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`nickname` text NOT NULL,
	`avatar` integer NOT NULL,
	`login_code` text NOT NULL,
	`chat_code` text NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`created_at` text NOT NULL,
	`last_seen` text NOT NULL,
	`theme_base_theme` text,
	`theme_color_theme` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_code_unique` ON `users` (`login_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_chat_code_unique` ON `users` (`chat_code`);