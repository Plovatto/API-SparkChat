ALTER TABLE `room_participants` ADD `invite_proof` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `invite_token_hash` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `encrypted_invite` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `invite_key_id` text;