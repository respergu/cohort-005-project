-- SQLite can only add a NOT NULL column with a constant default, so the column
-- starts as '' and every existing user gets a random UUID v4 straight after.
-- New rows always get theirs from the schema's $defaultFn.
ALTER TABLE `users` ADD `knock_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `users` SET `knock_id` = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89AB', 1 + (abs(random()) % 4), 1) ||
  substr(hex(randomblob(2)), 2) || '-' ||
  hex(randomblob(6))
);--> statement-breakpoint
CREATE UNIQUE INDEX `users_knock_id_unique` ON `users` (`knock_id`);
