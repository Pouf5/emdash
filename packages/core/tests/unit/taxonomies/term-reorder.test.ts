/**
 * Manual term ordering.
 *
 * Terms are listed by `(sort_order, label)`, so a taxonomy nobody has ordered
 * has to stay alphabetical — the behaviour before terms were sortable — and an
 * ordered one has to survive later term creation and translation.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	handleTermCreate,
	handleTermList,
	handleTermReorder,
} from "../../../src/api/handlers/taxonomies.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// Mock loader.getDb so the runtime taxonomy functions read from our test db.
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
	resetTaxonomyNamesCache: vi.fn(),
}));

import { getDb } from "../../../src/loader.js";
import {
	getTaxonomyTerms,
	invalidateTermCache,
	resetTaxonomyDefsCacheForTests,
} from "../../../src/taxonomies/index.js";

describeEachDialect("taxonomy term reorder", (dialect) => {
	let ctx: DialectTestContext;
	let repo: TaxonomyRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new TaxonomyRepository(ctx.db);
		vi.mocked(getDb).mockResolvedValue(ctx.db);
		resetTaxonomyDefsCacheForTests();
		invalidateTermCache();
	});

	afterEach(async () => {
		invalidateTermCache();
		await teardownForDialect(ctx);
		vi.restoreAllMocks();
	});

	/** Labels of the terms in `category`, in list order. */
	async function listLabels(): Promise<string[]> {
		const result = await handleTermList(ctx.db, "category", { includeCounts: false });
		if (!result.success) throw new Error(result.error.message);
		return result.data.terms.map((term) => term.label);
	}

	async function createCategories(labels: string[]) {
		const created = [];
		for (const label of labels) {
			created.push(await repo.create({ name: "category", slug: label.toLowerCase(), label }));
		}
		return created;
	}

	it("lists terms alphabetically until a group is ordered", async () => {
		await createCategories(["Zebra", "Apple", "Mango"]);

		expect(await listLabels()).toEqual(["Apple", "Mango", "Zebra"]);
	});

	it("lists a group in the order it was given", async () => {
		const [zebra, apple, mango] = await createCategories(["Zebra", "Apple", "Mango"]);

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [zebra!.id, mango!.id, apple!.id],
		});

		expect(result.success).toBe(true);
		expect(await listLabels()).toEqual(["Zebra", "Mango", "Apple"]);
	});

	it("reflects the order in the public runtime helper", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);

		await handleTermReorder(ctx.db, "category", { ids: [zebra!.id, apple!.id] });
		invalidateTermCache();

		const terms = await getTaxonomyTerms("category", { includeCounts: false });
		expect(terms.map((term) => term.label)).toEqual(["Zebra", "Apple"]);
	});

	it("rejects a list that is missing a term in the group, without reordering", async () => {
		const [zebra, apple, mango] = await createCategories(["Zebra", "Apple", "Mango"]);

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [mango!.id, zebra!.id],
		});

		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected a mismatch");
		expect(result.error.code).toBe("REORDER_MISMATCH");
		expect(await listLabels()).toEqual(["Apple", "Mango", "Zebra"]);
		expect(apple).toBeDefined();
	});

	it("rejects a list containing the same term twice", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [zebra!.id, zebra!.id, apple!.id],
		});

		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected a mismatch");
		expect(result.error.code).toBe("REORDER_MISMATCH");
	});

	it("rejects a term that belongs to another taxonomy", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);
		const tag = await repo.create({ name: "tag", slug: "news", label: "News" });

		const result = await handleTermReorder(ctx.db, "category", {
			ids: [zebra!.id, apple!.id, tag.id],
		});

		expect(result.success).toBe(false);
		if (result.success) throw new Error("expected a mismatch");
		expect(result.error.code).toBe("REORDER_MISMATCH");
	});

	it("orders each parent's children independently of the roots", async () => {
		const [alpha, beta] = await createCategories(["Alpha", "Beta"]);
		const child1 = await repo.create({
			name: "category",
			slug: "child-a",
			label: "Child A",
			parentId: alpha!.id,
		});
		const child2 = await repo.create({
			name: "category",
			slug: "child-z",
			label: "Child Z",
			parentId: alpha!.id,
		});

		// Reordering the children leaves the roots alphabetical...
		await handleTermReorder(ctx.db, "category", {
			parentId: alpha!.translationGroup,
			ids: [child2.id, child1.id],
		});
		let result = await handleTermList(ctx.db, "category", { includeCounts: false });
		if (!result.success) throw new Error(result.error.message);
		expect(result.data.terms.map((term) => term.label)).toEqual(["Alpha", "Beta"]);
		expect(result.data.terms[0]?.children.map((term) => term.label)).toEqual([
			"Child Z",
			"Child A",
		]);

		// ...and reordering the roots leaves the children as they were.
		await handleTermReorder(ctx.db, "category", { ids: [beta!.id, alpha!.id] });
		result = await handleTermList(ctx.db, "category", { includeCounts: false });
		if (!result.success) throw new Error(result.error.message);
		expect(result.data.terms.map((term) => term.label)).toEqual(["Beta", "Alpha"]);
		expect(result.data.terms[1]?.children.map((term) => term.label)).toEqual([
			"Child Z",
			"Child A",
		]);
	});

	it("adds a term to the end of a group that has been ordered", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);
		await handleTermReorder(ctx.db, "category", { ids: [zebra!.id, apple!.id] });

		const created = await handleTermCreate(ctx.db, "category", { slug: "banana", label: "Banana" });

		expect(created.success).toBe(true);
		expect(await listLabels()).toEqual(["Zebra", "Apple", "Banana"]);
	});

	it("keeps a term alphabetical when its group has never been ordered", async () => {
		await createCategories(["Zebra", "Apple"]);

		await handleTermCreate(ctx.db, "category", { slug: "banana", label: "Banana" });

		expect(await listLabels()).toEqual(["Apple", "Banana", "Zebra"]);
	});

	it("keeps a new term alphabetical when only another locale has been ordered", async () => {
		const es = await Promise.all(
			["Zebra", "Apple"].map((label) =>
				repo.create({ name: "category", slug: label.toLowerCase(), label, locale: "es" }),
			),
		);
		await handleTermReorder(ctx.db, "category", { ids: [es[0]!.id, es[1]!.id] }, { locale: "es" });

		// No locale on the create: the row lands in the default locale, whose
		// group nobody has ordered, so it must still sort alphabetically.
		await handleTermCreate(ctx.db, "category", { slug: "mango", label: "Mango" });
		await handleTermCreate(ctx.db, "category", { slug: "banana", label: "Banana" });

		const result = await handleTermList(ctx.db, "category", {
			locale: "en",
			includeCounts: false,
		});
		if (!result.success) throw new Error(result.error.message);
		expect(result.data.terms.map((term) => term.label)).toEqual(["Banana", "Mango"]);
	});

	it("orders the top level with a term whose parent is not translated", async () => {
		const [alpha, beta] = await createCategories(["Alpha", "Beta"]);
		// A child of Alpha in ES, while Alpha itself has no ES row: the term list
		// shows it at the top level, so reordering that level has to accept it.
		const orphan = await handleTermCreate(ctx.db, "category", {
			slug: "nino",
			label: "Nino",
			locale: "es",
			parentId: alpha!.translationGroup ?? alpha!.id,
		});
		if (!orphan.success) throw new Error(orphan.error.message);
		const esBeta = await handleTermCreate(ctx.db, "category", {
			slug: "beta",
			label: "Beta ES",
			locale: "es",
			translationOf: beta!.id,
		});
		if (!esBeta.success) throw new Error(esBeta.error.message);

		const listed = await handleTermList(ctx.db, "category", { locale: "es", includeCounts: false });
		if (!listed.success) throw new Error(listed.error.message);
		expect(listed.data.terms.map((term) => term.label)).toEqual(["Beta ES", "Nino"]);

		const result = await handleTermReorder(
			ctx.db,
			"category",
			{ ids: [orphan.data.term.id, esBeta.data.term.id] },
			{ locale: "es" },
		);

		expect(result.success).toBe(true);
		const list = await handleTermList(ctx.db, "category", { locale: "es", includeCounts: false });
		if (!list.success) throw new Error(list.error.message);
		expect(list.data.terms.map((term) => term.label)).toEqual(["Nino", "Beta ES"]);
	});

	it("gives a translated term the position of the term it translates", async () => {
		const [zebra, apple] = await createCategories(["Zebra", "Apple"]);
		await handleTermReorder(ctx.db, "category", { ids: [zebra!.id, apple!.id] });

		for (const source of [apple!, zebra!]) {
			const translated = await handleTermCreate(ctx.db, "category", {
				slug: source.slug,
				label: `${source.label} (ES)`,
				locale: "es",
				translationOf: source.id,
			});
			if (!translated.success) throw new Error(translated.error.message);
		}

		const result = await handleTermList(ctx.db, "category", {
			locale: "es",
			includeCounts: false,
		});
		if (!result.success) throw new Error(result.error.message);
		expect(result.data.terms.map((term) => term.label)).toEqual(["Zebra (ES)", "Apple (ES)"]);
	});
});
