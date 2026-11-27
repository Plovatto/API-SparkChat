CREATE TABLE `scheduled_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`room_id` text NOT NULL,
	`message_id` text NOT NULL,
	`card_id` text NOT NULL,
	`preview_sealed` text NOT NULL,
	`payload` text NOT NULL,
	`locale` text DEFAULT 'pt' NOT NULL,
	`time_zone` text NOT NULL,
	`send_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`failure_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_messages_message_id_unique` ON `scheduled_messages` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_messages_card_id_unique` ON `scheduled_messages` (`card_id`);--> statement-breakpoint
CREATE INDEX `scheduled_messages_status_send_idx` ON `scheduled_messages` (`status`,`send_at`);--> statement-breakpoint
CREATE INDEX `scheduled_messages_user_idx` ON `scheduled_messages` (`user_id`);--> statement-breakpoint
CREATE INDEX `users_status_text_expires_idx` ON `users` (`status_text_expires_at`) WHERE "users"."status_text_expires_at" is not null;