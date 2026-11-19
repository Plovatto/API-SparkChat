UPDATE `storage_usage` SET `bytes_used` = max(0, `bytes_used` - (SELECT coalesce(sum(`size`), 0) FROM `uploads` WHERE `message_id` IN (SELECT `id` FROM `messages` WHERE `room_id` IN (SELECT `id` FROM `rooms` WHERE `type` = 'group'))));--> statement-breakpoint
DELETE FROM `uploads` WHERE `message_id` IN (SELECT `id` FROM `messages` WHERE `room_id` IN (SELECT `id` FROM `rooms` WHERE `type` = 'group'));--> statement-breakpoint
DELETE FROM `messages` WHERE `room_id` IN (SELECT `id` FROM `rooms` WHERE `type` = 'group');--> statement-breakpoint
DELETE FROM `room_keys` WHERE `room_id` IN (SELECT `id` FROM `rooms` WHERE `type` = 'group');--> statement-breakpoint
DELETE FROM `room_bans` WHERE `room_id` IN (SELECT `id` FROM `rooms` WHERE `type` = 'group');--> statement-breakpoint
DELETE FROM `room_participants` WHERE `room_id` IN (SELECT `id` FROM `rooms` WHERE `type` = 'group');--> statement-breakpoint
DELETE FROM `rooms` WHERE `type` = 'group';
