CREATE TABLE `room_key_reports` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`key_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `user_id`, `key_id`, `sender_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `rooms` ADD `rotation_required_at` text;