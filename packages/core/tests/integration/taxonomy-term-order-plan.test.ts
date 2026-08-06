/**
 * Query-plan shape of the term listing reads once terms carry a manual order.
 *
 * `sort_order` leads the ORDER BY (`sort_order, label, id`), which no index
 * satisfies: `idx_taxonomies_name_locale` is `(name, locale)` and
 * `idx_taxonomies_parent` is `(parent_id)`. Both reads therefore seek the
 * sibling group through an index and sort it in a temp b-tree.
 *
 * That is deliberate, and it is what these assertions pin:
 *
 *   - The *seek* is the part that matters on stats-blind SQLite/D1. Before
 *     `idx_taxonomies_name_locale` the planner picked `idx_taxonomies_locale`
 *     and read every term in the locale per facet (#1723). Adding `sort_order`
 *     to the ORDER BY must not push it back there.
 *   - The *sort* is over one taxonomy's terms in one locale — tens of rows,
 *     already narrowed by the seek — and it costs no extra rows read, which is
 *     what D1 bills. `ORDER BY label` had the same temp b-tree before terms
 *     were sortable, so this is not a regression the manual order introduced.
 *
 * Eliminating the sort would take a five-column `(name, locale, sort_order,
 * label, id)` index, paid on every term write, on a table already carrying four
 * indexes. If someone decides that trade is worth making, the TEMP B-TREE
 * assertions below are the ones to delete — deliberately, not by accident.
 *
 * SQLite-only: `EXPLAIN QUERY PLAN` is a SQLite concern and, being stats-blind
 * here, the plan is schema-driven — matching D1 exactly.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let repo: TaxonomyRepository;
let captured: CapturedQuery[];
let parentGroup: string;

beforeEach(async () => {
	captured = [];
	sqlite = new Database(":memory:");
	db = new Kysely<DatabaseSchema>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level === "query") {
				captured.push({ sql: event.query.sql, parameters: event.query.parameters });
			}
		},
	});

	// Deliberately no ANALYZE: matches D1, which never maintains sqlite_stat1.
	await runMigrations(db);
	repo = new TaxonomyRepository(db);

	// One taxonomy dominates the locale, mirroring #1723: without the composite
	// index the planner reads every term in the locale to filter `name`.
	for (let i = 0; i < 40; i++) {
		await repo.create({ name: "tag", slug: `tag-${i}`, label: `Tag ${i}`, locale: "en" });
	}
	const parent = await repo.create({
		name: "category",
		slug: "news",
		label: "News",
		locale: "en",
	});
	parentGroup = parent.translationGroup ?? parent.id;
	for (let i = 0; i < 3; i++) {
		await repo.create({
			name: "category",
			slug: `child-${i}`,
			label: `Child ${i}`,
			parentId: parentGroup,
			locale: "en",
		});
	}
});

afterEach(async () => {
	await db.destroy();
});

/** better-sqlite3 only binds primitives; coerce the JS values Kysely captured. */
function bindable(p: unknown): unknown {
	if (typeof p === "boolean") return p ? 1 : 0;
	if (p instanceof Date) return p.toISOString();
	if (p === undefined) return null;
	return p;
}

/**
 * Plan of the last captured query whose SQL matches — the repository's real
 * emitted SQL, so the assertions can't drift from a hand-copied literal.
 */
function planOf(match: (sql: string) => boolean): string {
	const query = captured.findLast((q) => match(q.sql));
	expect(query, "expected a matching query to have been emitted").toBeDefined();
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query!.sql}`)
		.all(...query!.parameters.map(bindable)) as { detail: string }[];
	return rows.map((r) => r.detail).join("\n");
}

it("seeks findByName through the composite index rather than scanning the locale", async () => {
	captured = [];
	await repo.findByName("category", { locale: "en" });

	const plan = planOf((sql) => sql.includes('"name" = ?') && sql.includes("sort_order"));
	expect(plan).toContain("idx_taxonomies_name_locale");
	// Reading the whole locale to filter `name` in memory is the #1723 regression.
	expect(plan).not.toContain("idx_taxonomies_locale");
	expect(plan).not.toContain("SCAN taxonomies");
	// The seeked group is sorted in memory — see the header note.
	expect(plan).toContain("TEMP B-TREE");
});

it("seeks findChildren through the parent index", async () => {
	captured = [];
	await repo.findChildren(parentGroup, "en");

	const plan = planOf((sql) => sql.includes('"parent_id" = ?') && sql.includes("sort_order"));
	expect(plan).toContain("idx_taxonomies_parent");
	expect(plan).not.toContain("SCAN taxonomies");
	expect(plan).toContain("TEMP B-TREE");
});
