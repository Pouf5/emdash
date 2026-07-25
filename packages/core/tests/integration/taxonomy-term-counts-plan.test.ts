/**
 * Query-plan shape of the consolidated term-count query (#2237).
 *
 * On stats-blind SQLite/D1 (no ANALYZE, no `sqlite_stat1`) an `INNER JOIN`
 * between the pivot and the content table let the planner drive from `ec_*` and
 * re-run the `taxonomy_id IN (...)` term list as a pivot-PK probe for every
 * entry in the collection — `entries × terms` rows read per branch. Seeking the
 * pivot first makes it one index seek per term plus one primary-key touch per
 * assignment.
 *
 * This asserts the plan, not the output (output is covered by
 * unit/taxonomies/term-counts). SQLite-only: `EXPLAIN QUERY PLAN` is a SQLite
 * concern and, being stats-blind here, the plan is schema-driven — matching D1.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { fetchVisibleTermCounts } from "../../src/taxonomies/term-counts.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let sqlite: Database.Database;
let db: Kysely<DatabaseSchema>;
let captured: CapturedQuery[];

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
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema vs Database type
	const anyDb = db as any;
	const content = new ContentRepository(anyDb);
	const tax = new TaxonomyRepository(anyDb);

	// Many terms and many entries: the shape the bad plan multiplies together.
	// The plan is stats-blind so the counts are immaterial — they only make the
	// two access paths distinguishable to a reader.
	const terms = [];
	for (let i = 0; i < 5; i++) {
		terms.push(
			await tax.create({ name: "category", slug: `term-${i}`, label: `Term ${i}`, locale: "en" }),
		);
	}
	for (let i = 0; i < 20; i++) {
		const post = await content.create({
			type: "post",
			slug: `post-${i}`,
			data: { title: `Post ${i}` },
			status: "published",
			locale: "en",
		});
		await tax.attachToEntry("post", post.id, terms[i % terms.length]!.id);
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

function explain(query: CapturedQuery): string {
	const rows = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
		.all(...query.parameters.map(bindable)) as { detail: string }[];
	return rows.map((r) => r.detail).join("\n");
}

async function countQueryPlan(): Promise<string> {
	captured = [];
	await fetchVisibleTermCounts(db, "category", ["post"]);
	const query = captured.find((q) => q.sql.includes("content_taxonomies"));
	expect(query, "expected a term-count query against the pivot").toBeDefined();
	return explain(query!);
}

it("seeks the terms on a content_taxonomies index rather than probing the pivot per entry", async () => {
	const plan = await countQueryPlan();

	// The pivot is entered on a `taxonomy_id`-leading index, once per term.
	expect(plan).toMatch(/SEARCH ct USING (COVERING )?INDEX idx_content_taxonomies/);
	// The pivot's primary key is `(collection, entry_id, taxonomy_id)`. Reaching
	// the pivot through it means the planner is driving from `ec_*` and probing
	// the whole term list per entry — the #2237 blowup.
	expect(plan).not.toContain("sqlite_autoindex_content_taxonomies_1");
	expect(plan).not.toContain("SCAN ct");
});

it("touches the content table only by primary key", async () => {
	const plan = await countQueryPlan();

	expect(plan).toContain("SEARCH e USING");
	expect(plan).toMatch(/SEARCH e USING (COVERING )?INDEX sqlite_autoindex_ec_post_1 \(id=\?\)/);
	expect(plan).not.toContain("SCAN e");
});
