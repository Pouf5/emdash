import { sql } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentGet } from "../../../src/api/handlers/content.js";
import { validateContentData } from "../../../src/api/handlers/validation.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("storage-less fields are absent from content `data`", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("posts", {
			slug: "parent_page",
			label: "Parent Page",
			type: "reference",
			required: true,
			validation: { relation: "grp_parent_page", targetCollection: "pages" },
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("does not require a value in `data` for a required reference field", async () => {
		const result = await validateContentData(
			ctx.db,
			"posts",
			{ title: "A post" },
			{ partial: false },
		);

		expect(result).toEqual({ ok: true });
	});

	it("rejects a reference field sent in `data`, naming the key that replaces it", async () => {
		const result = await validateContentData(
			ctx.db,
			"posts",
			{ title: "A post", parent_page: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
			{ partial: false },
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(result.error.message).toContain("parent_page");
		expect(result.error.message).toContain("references");
	});

	it("rejects a reference field sent in `data` on a partial update too", async () => {
		const result = await validateContentData(
			ctx.db,
			"posts",
			{ parent_page: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
			{ partial: true },
		);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("parent_page");
	});

	it("rejects a reference field sent as null in `data`", async () => {
		// The admin's autosave re-sends what it loaded. A legacy entry whose
		// reference column was dropped by migration 070 must not be able to
		// smuggle the key back in as an empty value.
		const result = await validateContentData(
			ctx.db,
			"posts",
			{ title: "A post", parent_page: null },
			{ partial: false },
		);

		expect(result.ok).toBe(false);
	});

	it("does not return a legacy reference column in `data`", async () => {
		// A reference field created before the type became storage-less still has
		// its column. Nothing writes it any more, but a read that surfaced it
		// would feed the value straight back into a save the write path now
		// rejects. Simulate that install by adding the column by hand.
		await sql`ALTER TABLE ${sql.ref("ec_posts")} ADD COLUMN ${sql.ref("parent_page")} TEXT`.execute(
			ctx.db,
		);
		const repo = new ContentRepository(ctx.db);
		const created = await repo.create({ type: "posts", data: { title: "A post" }, slug: "a-post" });
		await sql`
			UPDATE ${sql.ref("ec_posts")}
			SET ${sql.ref("parent_page")} = ${"01ARZ3NDEKTSV4RRFFQ69G5FAV"}
			WHERE id = ${created.id}
		`.execute(ctx.db);

		const result = await handleContentGet(ctx.db, "posts", created.id);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.item.data).not.toHaveProperty("parent_page");
		expect(result.data.item.data.title).toBe("A post");
	});

	it("still requires column-backed fields", async () => {
		const result = await validateContentData(ctx.db, "posts", {}, { partial: false });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("title");
	});
});
