import type { Kysely } from "kysely";
import { sql } from "kysely";

import { listTablesLike } from "../dialect-helpers.js";

/**
 * Migration: replace the single-column partial `scheduled_at` index on content
 * tables with a `(deleted_at, scheduled_at)` composite.
 *
 * The scheduled-publishing sweep reads `scheduled_at IS NOT NULL AND
 * scheduled_at <= ? AND deleted_at IS NULL` ordered by `scheduled_at`. A
 * stats-blind planner cannot seek the `scheduled_at`-only partial index and
 * satisfy `deleted_at IS NULL` too, so it takes the `deleted_at=?` equality on
 * whichever `deleted_at`-leading composite it finds first, reads every live row
 * in the table, and sorts the result in a temp b-tree. The sweep runs per
 * collection on every scheduler tick, so a site with no scheduled content still
 * pays its entire content size in reads every tick.
 *
 * Leading with `deleted_at` lets the same index serve the equality and then walk
 * `scheduled_at` in order, which satisfies the range and the ORDER BY together.
 * The partial `WHERE scheduled_at IS NOT NULL` clause is kept so the index stays
 * proportional to scheduled content rather than to the table. D1 never has
 * `sqlite_stat1`, so the index shape is the only lever.
 *
 * Forward-only and idempotent (`IF NOT EXISTS`).
 *
 * The short `del_sched` suffix keeps the name inside Postgres's 63-byte
 * identifier limit for long collection slugs. Keep it identical to the name in
 * `schema/registry.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		// D1 DDL is non-transactional: create the replacement before dropping the
		// old index so an interrupted migration always leaves a scheduled_at index
		// in place.
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_del_sched`)}
			ON ${sql.ref(tableName)} (deleted_at, scheduled_at)
			WHERE scheduled_at IS NOT NULL
		`.execute(db);

		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_scheduled`)}`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	const tableNames = await listTablesLike(db, "ec_%");

	for (const tableName of tableNames) {
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_scheduled`)}
			ON ${sql.ref(tableName)} (scheduled_at)
			WHERE scheduled_at IS NOT NULL
		`.execute(db);

		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_del_sched`)}`.execute(db);
	}
}
