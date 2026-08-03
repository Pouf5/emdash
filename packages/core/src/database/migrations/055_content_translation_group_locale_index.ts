import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTablesLike } from "../dialect-helpers.js";

/**
 * Migration: widen the content `translation_group` index to cover the locale sort.
 *
 * Translation-group reads filter `translation_group = ?` / `IN (...)` with
 * `deleted_at IS NULL` and `ORDER BY locale ASC`. Seeking migration 041's
 * `(deleted_at, locale, ...)` composites on `deleted_at` alone already returns
 * rows in locale order, so a stats-blind planner prefers them over the
 * single-column `translation_group` index and reads every non-deleted row in
 * the table. D1 never has `sqlite_stat1`, so the index shape is the only lever.
 *
 * `(translation_group, locale)` serves both the equality seek and the sort, so
 * it wins on the planner's own cost terms without statistics.
 *
 * Forward-only and idempotent (`IF NOT EXISTS`).
 *
 * Index names use a short `tg_locale` suffix rather than spelling out
 * `translation_group_locale`: Postgres truncates identifiers to 63 bytes, and
 * the longer form truncates away the discriminator for long collection slugs.
 * Keep this identical to the name in `schema/registry.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		// D1 DDL is non-transactional: create the replacement before dropping the
		// old index so an interrupted migration always leaves a
		// translation_group-leading index in place.
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_tg_locale`)}
			ON ${sql.ref(tableName)} (translation_group, locale)
		`.execute(db);

		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_translation_group`)}`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_translation_group`)}
			ON ${sql.ref(tableName)} (translation_group)
		`.execute(db);

		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_tg_locale`)}`.execute(db);
	}
}
