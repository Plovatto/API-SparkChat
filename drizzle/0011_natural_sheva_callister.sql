CREATE TABLE `link_previews` (
	`url` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`title` text,
	`description` text,
	`image_url` text,
	`site_name` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `link_preview` text;