ALTER TABLE `uploads` ADD `expires_at` text;--> statement-breakpoint
CREATE INDEX `uploads_expires_at_idx` ON `uploads` (`expires_at`);