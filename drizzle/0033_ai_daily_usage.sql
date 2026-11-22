CREATE TABLE `ai_daily_usage` (
	`user_id` text NOT NULL,
	`usage_date` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `usage_date`)
);
--> statement-breakpoint
CREATE INDEX `ai_daily_usage_date_idx` ON `ai_daily_usage` (`usage_date`);