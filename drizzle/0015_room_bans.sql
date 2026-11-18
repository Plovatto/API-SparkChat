CREATE TABLE `room_bans` (
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`banned_by` text,
	`banned_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `user_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
UPDATE `room_participants` SET `blocked_by_user_id` = NULL, `blocked_at` = NULL WHERE `blocked_by_user_id` IS NOT NULL AND `room_id` IN (SELECT `id` FROM `rooms` WHERE `type` = 'group');