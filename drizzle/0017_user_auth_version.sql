ALTER TABLE `users` ADD `auth_salt` text;--> statement-breakpoint
ALTER TABLE `users` ADD `auth_version` integer DEFAULT 1 NOT NULL;