CREATE TABLE `assistant_card_resolutions` (
	`card_message_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`choice` text NOT NULL,
	`resolved_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `assistant_card` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `quick_reply` text;--> statement-breakpoint
ALTER TABLE `users` ADD `time_zone` text;--> statement-breakpoint
ALTER TABLE `users` ADD `status_text_expires_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `status_text_previous` text;