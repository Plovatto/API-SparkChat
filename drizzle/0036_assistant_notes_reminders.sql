CREATE TABLE `assistant_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`content_sealed` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assistant_notes_user_idx` ON `assistant_notes` (`user_id`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`text_sealed` text NOT NULL,
	`next_fire_at` integer NOT NULL,
	`time_zone` text NOT NULL,
	`locale` text DEFAULT 'pt' NOT NULL,
	`recurrence` text,
	`anchor` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_fired_at` integer,
	`snooze_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reminders_status_next_fire_idx` ON `reminders` (`status`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX `reminders_user_idx` ON `reminders` (`user_id`);