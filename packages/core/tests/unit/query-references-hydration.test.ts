/**
 * Reference hydration on the public content query API.
 *
 * Reference fields hold no column, so a site can only reach their selections
 * through `entry.references`. These cover what a template actually sees, plus
 * the two properties that keep it affordable: a collection with no reference
 * fields must not pay for the feature, and a page of entries must not turn into
 * a query per entry.
 */

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RelationRepository } from "../../src/database/repositories/relation.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { getEmDashCollection, getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveCollection, getLiveEntry } from "astro:content";

const openDbs: Kysely<Database>[] = [];

async function setupCountingDb(): Promise<{
	db: Kysely<Database>;
	queries: string[];
	reset: () => void;
}> {
	const sqlite = new BetterSqlite3(":memory:");
	const queries: string[] = [];
	const db = new Kysely<Database>({
		dialect: new SqliteDialect({ database: sqlite }),
		log: (event) => {
			if (event.level === "query") queries.push(event.query.sql);
		},
	});
	openDbs.push(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "page", label: "Pages", labelSingular: "Page" });
	await registry.createField("page", { slug: "title", label: "Title", type: "string" });
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });

	return { db, queries, reset: () => queries.splice(0, queries.length) };
}

/** Add a `related` reference field on `post` pointing at `page`. */
async function addReferenceField(db: Kysely<Database>) {
	const relation = await new RelationRepository(db).create({
		name: "post_related",
		parentCollection: "post",
		childCollection: "page",
		parentLabel: "Posts",
		childLabel: "Related",
	});
	await new SchemaRegistry(db).createField("post", {
		slug: "related",
		label: "Related",
		type: "reference",
		validation: {
			relation: relation.translationGroup,
			targetCollection: "page",
			multiple: true,
		},
	});
	return relation;
}

function delegateToLoader() {
	const loader = emdashLoader();
	vi.mocked(getLiveCollection).mockImplementation(async (_name: string, filter: unknown) =>
		// eslint-disable-next-line typescript/no-explicit-any -- loader filter is a runtime-validated union
		loader.loadCollection!({ filter: filter as any }),
	);
	// `loadEntry` returns the entry itself; `getLiveEntry` is what wraps it in
	// `{ entry, error, cacheHint }`, so the delegation has to do that here.
	vi.mocked(getLiveEntry).mockImplementation(async (_name: string, filter: unknown) => {
		// eslint-disable-next-line typescript/no-explicit-any -- loader filter is a runtime-validated union
		const result = await loader.loadEntry!({ filter: filter as any });
		// eslint-disable-next-line typescript/no-explicit-any -- loader result shape
		const raw = result as any;
		if (!raw || raw.error) return { entry: undefined, error: raw?.error, cacheHint: {} };
		return { entry: raw, error: undefined, cacheHint: raw.cacheHint ?? {} };
	});
}

/**
 * Reference lookups issued by the hydration path. The content SELECT reads the
 * edge table too — that's the folded existence probe, which costs no round trip
 * — so it doesn't count.
 */
function referenceQueries(queries: string[]): string[] {
	return queries.filter((q) => !q.includes("ec_post") && q.includes("_emdash_content_references"));
}

describe("public reference hydration", () => {
	afterEach(async () => {
		vi.mocked(getLiveCollection).mockReset();
		vi.mocked(getLiveEntry).mockReset();
		for (const db of openDbs.splice(0)) {
			await db.destroy();
		}
	});

	it("exposes referenced entries with their own data, in edge order", async () => {
		const { db } = await setupCountingDb();
		const relation = await addReferenceField(db);
		const repo = new ContentRepository(db);
		const one = await repo.create({
			type: "page",
			slug: "one",
			data: { title: "One" },
			status: "published",
		});
		const two = await repo.create({
			type: "page",
			slug: "two",
			data: { title: "Two" },
			status: "published",
		});
		const post = await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
		});
		await new RelationRepository(db).setChildren(
			relation.translationGroup,
			post.translationGroup!,
			[two.translationGroup!, one.translationGroup!],
		);
		delegateToLoader();

		const entries = await runWithContext({ editMode: false, db }, async () => {
			const result = await getEmDashCollection("post", { status: "published" });
			return result.entries;
		});

		const related = entries[0]!.references.related;
		expect(related?.map((r) => r.slug)).toEqual(["two", "one"]);
		expect(related?.[0]?.data.title).toBe("Two");
		expect(related?.[0]?.collection).toBe("page");
	});

	it("keys references by field slug on a single entry read", async () => {
		const { db } = await setupCountingDb();
		const relation = await addReferenceField(db);
		const repo = new ContentRepository(db);
		const page = await repo.create({
			type: "page",
			slug: "target",
			data: { title: "Target" },
			status: "published",
		});
		const post = await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
			// The single-entry path additionally checks visibility, which needs a
			// publish date in the past.
			publishedAt: new Date(Date.now() - 1000).toISOString(),
		});
		await new RelationRepository(db).setChildren(
			relation.translationGroup,
			post.translationGroup!,
			[page.translationGroup!],
		);
		delegateToLoader();

		const entry = await runWithContext({ editMode: false, db }, async () => {
			const result = await getEmDashEntry("post", "hello");
			return result.entry;
		});

		expect(entry).not.toBeNull();
		expect(entry?.references.related?.map((r) => r.slug)).toEqual(["target"]);
	});

	it("omits a draft child from a public read", async () => {
		const { db } = await setupCountingDb();
		const relation = await addReferenceField(db);
		const repo = new ContentRepository(db);
		const draft = await repo.create({
			type: "page",
			slug: "draft-target",
			data: { title: "Draft" },
			status: "draft",
		});
		const published = await repo.create({
			type: "page",
			slug: "live-target",
			data: { title: "Live" },
			status: "published",
		});
		const post = await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
		});
		await new RelationRepository(db).setChildren(
			relation.translationGroup,
			post.translationGroup!,
			[draft.translationGroup!, published.translationGroup!],
		);
		delegateToLoader();

		const entries = await runWithContext({ editMode: false, db }, async () => {
			const result = await getEmDashCollection("post", { status: "published" });
			return result.entries;
		});

		// A draft child is skipped exactly like a deleted one — a public read must
		// not leak an unpublished entry's slug through a reference.
		expect(entries[0]!.references.related?.map((r) => r.slug)).toEqual(["live-target"]);
	});

	it("issues no reference queries for a collection with no reference fields", async () => {
		const { db, queries, reset } = await setupCountingDb();
		const repo = new ContentRepository(db);
		await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
		});
		delegateToLoader();

		const entries = await runWithContext({ editMode: false, db }, async () => {
			reset();
			const result = await getEmDashCollection("post", { status: "published" });
			return result.entries;
		});

		// Hydration is unconditional, so the cost of having no reference fields
		// has to be zero round trips, not "one cheap one".
		expect(entries[0]!.references).toEqual({});
		expect(referenceQueries(queries)).toEqual([]);
	});

	it("issues no reference queries when the collection has a field but no edges", async () => {
		const { db, queries, reset } = await setupCountingDb();
		await addReferenceField(db);
		const repo = new ContentRepository(db);
		await repo.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
		});
		delegateToLoader();

		const entries = await runWithContext({ editMode: false, db }, async () => {
			reset();
			const result = await getEmDashCollection("post", { status: "published" });
			return result.entries;
		});

		// The folded probe reports the edge table empty, so hydration stops before
		// the schema lookup — the field existing is not enough to pay for one.
		expect(entries[0]!.references).toEqual({});
		expect(referenceQueries(queries)).toEqual([]);
		expect(queries.filter((q) => q.includes("_emdash_fields"))).toEqual([]);
	});

	it("hydrates a page of entries without a query per entry", async () => {
		const { db, queries, reset } = await setupCountingDb();
		const relation = await addReferenceField(db);
		const repo = new ContentRepository(db);
		const relationRepo = new RelationRepository(db);
		const page = await repo.create({
			type: "page",
			slug: "shared",
			data: { title: "Shared" },
			status: "published",
		});
		for (let i = 0; i < 5; i++) {
			const post = await repo.create({
				type: "post",
				slug: `post-${i}`,
				data: { title: `Post ${i}` },
				status: "published",
			});
			await relationRepo.setChildren(relation.translationGroup, post.translationGroup!, [
				page.translationGroup!,
			]);
		}
		delegateToLoader();

		const entries = await runWithContext({ editMode: false, db }, async () => {
			reset();
			const result = await getEmDashCollection("post", { status: "published" });
			return result.entries;
		});

		expect(entries).toHaveLength(5);
		for (const entry of entries) {
			expect(entry.references.related?.map((r) => r.slug)).toEqual(["shared"]);
		}
		// One batched edge read for the whole page, however many entries it holds.
		expect(referenceQueries(queries)).toHaveLength(1);
	});
});
