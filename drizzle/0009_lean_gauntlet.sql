CREATE TABLE `room_keys` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`sealed_key` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `user_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `room_keys_user_id_idx` ON `room_keys` (`user_id`);