CREATE TABLE `uploads` (
	`key` text PRIMARY KEY NOT NULL,
	`uploader_id` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` text NOT NULL,
	`message_id` text
);
--> statement-breakpoint
CREATE INDEX `uploads_uploader_id_idx` ON `uploads` (`uploader_id`);--> statement-breakpoint
CREATE INDEX `uploads_message_id_created_at_idx` ON `uploads` (`message_id`,`created_at`);