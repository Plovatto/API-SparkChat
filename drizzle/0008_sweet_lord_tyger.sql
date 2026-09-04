ALTER TABLE `users` ADD `e2e_public_key` text;--> statement-breakpoint
ALTER TABLE `users` ADD `e2e_encrypted_private_key_by_password` text;--> statement-breakpoint
ALTER TABLE `users` ADD `e2e_encrypted_private_key_by_recovery` text;