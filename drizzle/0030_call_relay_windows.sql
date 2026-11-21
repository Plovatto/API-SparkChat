ALTER TABLE `calls` ADD `caller_relay_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `calls` ADD `callee_relay_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `calls` ADD `caller_relay_since` text;--> statement-breakpoint
ALTER TABLE `calls` ADD `callee_relay_since` text;--> statement-breakpoint
UPDATE `calls` SET `caller_relay_since` = `answered_at` WHERE `state` != 'ended' AND `answered_at` IS NOT NULL AND `turn_username` IS NOT NULL;--> statement-breakpoint
UPDATE `calls` SET `callee_relay_since` = `answered_at` WHERE `state` != 'ended' AND `answered_at` IS NOT NULL AND `callee_turn_username` IS NOT NULL;
