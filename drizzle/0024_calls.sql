CREATE TABLE `call_usage` (
	`month` text PRIMARY KEY NOT NULL,
	`estimated_bytes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `calls` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`caller_id` text NOT NULL,
	`callee_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`answered_at` text,
	`ended_at` text,
	`end_reason` text,
	`last_heartbeat_at` text,
	`accepted_device_id` text,
	`relay_used` integer DEFAULT 0 NOT NULL,
	`turn_username` text,
	`callee_turn_username` text,
	`turn_revoked_at` text
);
--> statement-breakpoint
CREATE INDEX `calls_state_idx` ON `calls` (`state`);--> statement-breakpoint
CREATE INDEX `calls_caller_id_idx` ON `calls` (`caller_id`);--> statement-breakpoint
CREATE INDEX `calls_callee_id_idx` ON `calls` (`callee_id`);