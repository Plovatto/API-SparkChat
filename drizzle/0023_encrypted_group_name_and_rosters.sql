CREATE TABLE `room_rosters` (
	`room_id` text NOT NULL,
	`key_id` text NOT NULL,
	`encrypted_roster` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `key_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `rooms` ADD `encrypted_name` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `name_key_id` text;--> statement-breakpoint
UPDATE `rooms` SET `name` = NULL WHERE `type` = 'group';--> statement-breakpoint
INSERT INTO `room_rosters` (`room_id`, `key_id`, `encrypted_roster`, `created_at`) SELECT `id`, `roster_key_id`, `encrypted_roster`, `created_at` FROM `rooms` WHERE `type` = 'group' AND `encrypted_roster` IS NOT NULL AND `roster_key_id` IS NOT NULL;