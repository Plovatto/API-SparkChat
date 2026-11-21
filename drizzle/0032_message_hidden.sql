CREATE TABLE `message_hidden` (
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`hidden_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `message_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_hidden_message_id_idx` ON `message_hidden` (`message_id`);