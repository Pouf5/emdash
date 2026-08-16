import { expect, it } from "vitest";

import { handleContentCreate, handleContentUpdate } from "../../../src/api/handlers/content.js";
import { handleReferenceChildrenSet } from "../../../src/api/handlers/relations.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { describeEachDialect, setupForDialect, teardownForDialect } from "../../utils/test-db.js";
import type { DialectTestContext } from "../../utils/test-db.js";

/**
 * `posts` with two reference fields onto `pages`: `one` accepts a single child
 * and is required, `many` accepts several and is optional.
 *
 * The child collection is deliberately a different one. A required reference
 * field pointing at its own collection makes the collection's first entry
 * impossible to create — there is nothing to reference yet — which is a
 * property of `required` on a self-relation, not something to test around.
 */
async function setupConstrainedFields(db: DialectTestContext["db"]) {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
	await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
	await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
	await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

	const relationRepo = new RelationRepository(db);
	const single = await relationRepo.create({
		name: "posts_one",
		parentCollection: "posts",
		childCollection: "pages",
		parentLabel: "Posts",
		childLabel: "One",
	});
	const multi = await relationRepo.create({
		name: "posts_many",
		parentCollection: "posts",
		childCollection: "pages",
		parentLabel: "Posts",
		childLabel: "Many",
	});

	await registry.createField("posts", {
		slug: "one",
		label: "One",
		type: "reference",
		required: true,
		validation: {
			relation: single.translationGroup,
			targetCollection: "pages",
			multiple: false,
		},
	});
	await registry.createField("posts", {
		slug: "many",
		label: "Many",
		type: "reference",
		validation: {
			relation: multi.translationGroup,
			targetCollection: "pages",
			multiple: true,
		},
	});

	return { relationRepo, single, multi };
}

describeEachDialect("reference field required/multiple constraints", (dialect) => {
	let ctx: DialectTestContext;

	it("rejects more than one child on a single-reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { single } = await setupConstrainedFields(ctx.db);
			const a = await handleContentCreate(ctx.db, "pages", { data: { title: "A" } });
			const b = await handleContentCreate(ctx.db, "pages", { data: { title: "B" } });
			if (!a.success || !b.success) throw new Error("setup failed");

			const contentRepo = new ContentRepository(ctx.db);
			const countBefore = await contentRepo.count("posts");

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { [single.translationGroup]: [a.data.item.id, b.data.item.id] },
			});

			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
			// The constraint has to be checked before the entry is written, not
			// after — a rejected save must leave nothing behind.
			expect(await contentRepo.count("posts")).toBe(countBefore);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("accepts exactly one child on a single-reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { single } = await setupConstrainedFields(ctx.db);
			const a = await handleContentCreate(ctx.db, "pages", { data: { title: "A" } });
			if (!a.success) throw new Error("setup failed");

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { [single.translationGroup]: [a.data.item.id] },
			});

			expect(res.success).toBe(true);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rejects an empty list for a required reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { single } = await setupConstrainedFields(ctx.db);

			const res = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { [single.translationGroup]: [] },
			});

			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rejects a create that omits a required reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			await setupConstrainedFields(ctx.db);

			const res = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });

			expect(res.success).toBe(false);
			if (!res.success) {
				expect(res.error.code).toBe("VALIDATION_ERROR");
				expect(res.error.message).toContain("one");
			}
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rejects an update that clears a required reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { single } = await setupConstrainedFields(ctx.db);
			const a = await handleContentCreate(ctx.db, "pages", { data: { title: "A" } });
			if (!a.success) throw new Error("setup failed");
			const parent = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { [single.translationGroup]: [a.data.item.id] },
			});
			if (!parent.success) throw new Error("setup failed");

			const res = await handleContentUpdate(ctx.db, "posts", parent.data.item.id, {
				references: { [single.translationGroup]: [] },
			});

			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("allows an update that does not mention the required reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { single } = await setupConstrainedFields(ctx.db);
			const a = await handleContentCreate(ctx.db, "pages", { data: { title: "A" } });
			if (!a.success) throw new Error("setup failed");
			const parent = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { [single.translationGroup]: [a.data.item.id] },
			});
			if (!parent.success) throw new Error("setup failed");

			// Partial update semantics: an untouched field keeps whatever it had,
			// exactly as a required column-backed field does.
			const res = await handleContentUpdate(ctx.db, "posts", parent.data.item.id, {
				data: { title: "Renamed" },
			});

			expect(res.success).toBe(true);
		} finally {
			await teardownForDialect(ctx);
		}
	});
});

describeEachDialect("reference constraints on the edge endpoint", (dialect) => {
	let ctx: DialectTestContext;

	it("rejects more than one child on a single-reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { single } = await setupConstrainedFields(ctx.db);
			const a = await handleContentCreate(ctx.db, "pages", { data: { title: "A" } });
			const b = await handleContentCreate(ctx.db, "pages", { data: { title: "B" } });
			if (!a.success || !b.success) throw new Error("setup failed");
			const parent = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { [single.translationGroup]: [a.data.item.id] },
			});
			if (!parent.success) throw new Error("setup failed");

			// Enforcing only in the content body would leave the constraint
			// bypassable by anyone calling the edge endpoint directly.
			const res = await handleReferenceChildrenSet(
				ctx.db,
				"posts",
				parent.data.item.id,
				single.translationGroup,
				[a.data.item.id, b.data.item.id],
			);

			expect(res.success).toBe(false);
			if (!res.success) expect(res.error.code).toBe("VALIDATION_ERROR");
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("rejects clearing a required reference field", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const { single } = await setupConstrainedFields(ctx.db);
			const a = await handleContentCreate(ctx.db, "pages", { data: { title: "A" } });
			if (!a.success) throw new Error("setup failed");
			const parent = await handleContentCreate(ctx.db, "posts", {
				data: { title: "Parent" },
				references: { [single.translationGroup]: [a.data.item.id] },
			});
			if (!parent.success) throw new Error("setup failed");

			const res = await handleReferenceChildrenSet(
				ctx.db,
				"posts",
				parent.data.item.id,
				single.translationGroup,
				[],
			);

			expect(res.success).toBe(false);
		} finally {
			await teardownForDialect(ctx);
		}
	});

	it("leaves a relation with no backing field unconstrained", async () => {
		ctx = await setupForDialect(dialect);
		try {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

			// Relations exist independently of reference fields — the relations API
			// can create one with no field behind it. Those carry no `multiple` or
			// `required` config, so nothing constrains them.
			const relation = await new RelationRepository(ctx.db).create({
				name: "loose",
				parentCollection: "posts",
				childCollection: "posts",
				parentLabel: "Posts",
				childLabel: "Loose",
			});

			const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
			const a = await handleContentCreate(ctx.db, "posts", { data: { title: "A" } });
			const b = await handleContentCreate(ctx.db, "posts", { data: { title: "B" } });
			if (!parent.success || !a.success || !b.success) throw new Error("setup failed");

			const res = await handleReferenceChildrenSet(
				ctx.db,
				"posts",
				parent.data.item.id,
				relation.translationGroup,
				[a.data.item.id, b.data.item.id],
			);

			expect(res.success).toBe(true);
		} finally {
			await teardownForDialect(ctx);
		}
	});
});
