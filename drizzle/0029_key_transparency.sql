CREATE TABLE `transparency_leaves` (
	`position` integer PRIMARY KEY NOT NULL,
	`leaf_id` text NOT NULL,
	`version` integer NOT NULL,
	`identity_key` text NOT NULL,
	`signing_key` text NOT NULL,
	`leaf_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transparency_leaves_leaf_version_idx` ON `transparency_leaves` (`leaf_id`,`version`);--> statement-breakpoint
CREATE TABLE `transparency_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transparency_nodes` (
	`level` integer NOT NULL,
	`position` integer NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`level`, `position`)
);
