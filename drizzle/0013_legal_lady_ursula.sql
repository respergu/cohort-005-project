CREATE TABLE `notification_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow` text NOT NULL,
	`recipients` text NOT NULL,
	`actor` text,
	`data` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_idempotency_key_unique` ON `notification_outbox` (`idempotency_key`);