import { type Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Add `taxonomies.sort_order` so terms carry an explicit manual order.
 *
 * Term listings order by `(sort_order, label, id)`. Existing rows all default
 * to 0, so every taxonomy keeps its current alphabetical order until an admin
 * reorders one — at which point that sibling group is renumbered 0..n-1.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!(await columnExists(db, "taxonomies", "sort_order"))) {
		await db.schema
			.alterTable("taxonomies")
			.addColumn("sort_order", "integer", (col) => col.notNull().defaultTo(0))
			.execute();
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "taxonomies", "sort_order")) {
		await db.schema.alterTable("taxonomies").dropColumn("sort_order").execute();
	}
}
