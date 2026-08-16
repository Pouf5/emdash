/**
 * MCP field-level validation tests.
 *
 * `EmDashRuntime.handleContentCreate` and `handleContentUpdate` validate
 * `data` against the collection's schema before any write:
 *
 *   - required fields must be present and non-empty
 *   - select / multiSelect values must match the configured options
 *   - reference fields must resolve to a real, non-trashed target
 *
 * Failures return `{ code: "VALIDATION_ERROR", message: "<field>: <reason>" }`
 * with all offending fields named in one message so callers can fix
 * everything in a single round trip. These tests cover both REST and MCP
 * because validation runs at the runtime layer and both transports go
 * through it.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleSchemaFieldCreate } from "../../../src/api/handlers/schema.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { connectMcpHarness, extractText, type McpHarness } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

const VALIDATION_ERROR = /validation|required|invalid/i;
const GENERIC_FAILURE = /^Failed to (create|update) content$/;

// ---------------------------------------------------------------------------
// Bug #4: required field validation
// ---------------------------------------------------------------------------

describe("MCP validation — required fields (bug #4)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "post", label: "Posts" });
		// Required title, optional body
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("post", {
			slug: "body",
			label: "Body",
			type: "text",
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects create without required title", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { body: "no title" } },
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).not.toMatch(GENERIC_FAILURE);
		expect(text).toMatch(VALIDATION_ERROR);
		expect(text).toMatch(/title/i);
	});

	it("rejects create with empty-string required title", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "" } },
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
	});

	it("rejects create with explicitly-null required title", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: null } },
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
	});

	it("rejects create with non-string value for a string field", async () => {
		// Zod's `z.string()` rejects numbers/booleans/objects. The MCP
		// boundary lets these through (data is `z.record(z.string(),
		// z.unknown())`), so the check has to live in the runtime
		// validator. Guard against future regressions like swapping in
		// `z.coerce.string()`.
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				// eslint-disable-next-line typescript/no-explicit-any -- intentionally bypass MCP type to hit runtime validation
				data: { title: 42 } as any,
			},
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
		expect(extractText(result)).toMatch(/title/i);
		const meta = (result as { _meta?: { code?: string } })._meta;
		expect(meta?.code).toBe("VALIDATION_ERROR");
	});

	it("accepts create with required title present (regression guard)", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Has title" } },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("rejects update that clears required title to empty string", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Initial" } },
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = JSON.parse(extractText(created)).item.id as string;

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { title: "" } },
		});
		expect(updated.isError).toBe(true);
		expect(extractText(updated)).toMatch(VALIDATION_ERROR);
	});
});

// ---------------------------------------------------------------------------
// Bug #5: select and multiSelect option enforcement
// ---------------------------------------------------------------------------

describe("MCP validation — select and multiSelect options (bug #5)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "post", label: "Posts" });
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("post", {
			slug: "priority",
			label: "Priority",
			type: "select",
			validation: { options: ["low", "medium", "high"] },
		});
		await registry.createField("post", {
			slug: "tags",
			label: "Tags",
			type: "multiSelect",
			validation: { options: ["news", "tech", "design"] },
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects select value not in options list", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", priority: "not-an-option" },
			},
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
		expect(extractText(result)).toMatch(/priority|select|option|not-an-option/i);
	});

	it("accepts select value in options list (regression guard)", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", priority: "high" },
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("rejects multiSelect array containing an invalid value", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", tags: ["news", "bogus"] },
			},
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
		expect(extractText(result)).toMatch(/tags|multiSelect|option|bogus/i);
	});

	it("accepts multiSelect with all valid values (regression guard)", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", tags: ["news", "tech"] },
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("rejects update introducing an invalid select value", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", priority: "low" },
			},
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = JSON.parse(extractText(created)).item.id as string;

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { priority: "URGENT" } },
		});
		expect(updated.isError).toBe(true);
		expect(extractText(updated)).toMatch(VALIDATION_ERROR);
	});
});

// ---------------------------------------------------------------------------
// Bug #6: reference field target existence
// ---------------------------------------------------------------------------

describe("MCP validation — reference field targets (bug #6)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "page", label: "Pages" });
		await registry.createField("page", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});

		await registry.createCollection({ slug: "post", label: "Posts" });
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		// Through the handler, not the registry: a reference field is only
		// usable once the relation behind it exists.
		const field = await handleSchemaFieldCreate(db, "post", {
			slug: "parent_page",
			label: "Parent Page",
			type: "reference",
			validation: { targetCollection: "page" },
		});
		if (!field.success) throw new Error(field.error.message);

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects a reference sent in `data`, whatever the target", async () => {
		const page = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "page", data: { title: "Real page" } },
		});
		expect(page.isError, extractText(page)).toBeFalsy();
		const pageId = JSON.parse(extractText(page)).item.id as string;

		const post = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", parent_page: pageId },
			},
		});

		expect(post.isError).toBe(true);
		const text = extractText(post);
		expect(text).toMatch(VALIDATION_ERROR);
		// The error has to name the offending field and the key that replaces
		// it, or a caller has no way to work out what to send instead.
		expect(text).toContain("parent_page");
		expect(text).toContain("references");
	});

	it("rejects a reference to a non-existent target the same way", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", parent_page: "01NOTAREALPAGE" },
			},
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toContain("parent_page");
	});

	it("creates an entry that omits the reference field", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});

		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("persists a reference passed in `references` and returns it on read", async () => {
		const page = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "page", data: { title: "Real page" } },
		});
		const pageId = JSON.parse(extractText(page)).item.id as string;

		const post = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T" },
				references: { parent_page: [pageId] },
			},
		});
		expect(post.isError, extractText(post)).toBeFalsy();
		const postId = JSON.parse(extractText(post)).item.id as string;

		const read = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: postId },
		});

		expect(read.isError, extractText(read)).toBeFalsy();
		const item = JSON.parse(extractText(read)).item;
		expect(item.data).not.toHaveProperty("parent_page");
		expect(item.references.parent_page.children).toHaveLength(1);
		expect(item.references.parent_page.children[0].id).toBe(pageId);
	});

	it("does not return the reference field in `data` on read", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const postId = JSON.parse(extractText(created)).item.id as string;

		const read = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: postId },
		});

		expect(read.isError, extractText(read)).toBeFalsy();
		expect(JSON.parse(extractText(read)).item.data).not.toHaveProperty("parent_page");
	});
});

// ---------------------------------------------------------------------------
// Combined: error message is structured even when multiple fields fail
// ---------------------------------------------------------------------------

describe("MCP validation — multi-field error messaging", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "post", label: "Posts" });
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("post", {
			slug: "priority",
			label: "Priority",
			type: "select",
			validation: { options: ["low", "high"] },
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("when multiple fields fail validation, the error mentions all of them", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				// missing required title AND invalid priority
				collection: "post",
				data: { priority: "URGENT" },
			},
		});
		expect(result.isError).toBe(true);
		const text = extractText(result);
		// Both field names should appear so a caller can fix everything in one round.
		expect(text).toMatch(/title/i);
		expect(text).toMatch(/priority/i);
	});
});

// ---------------------------------------------------------------------------
// F4: validation runs on UPDATE for revision-supporting collections.
//
// Before the fix, the runtime wrote the draft revision *before* the API
// handler ran (and called the handler with `data: undefined`), so update-
// time validation was bypassed for any collection that supports revisions.
// ---------------------------------------------------------------------------

describe("MCP validation — UPDATE on revision-supporting collections (F4)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;
	let postId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			supports: ["drafts", "revisions"],
		});
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const create = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Initial title" } },
		});
		expect(create.isError, extractText(create)).toBeFalsy();
		postId = JSON.parse(extractText(create)).item.id as string;
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects update with empty required field BEFORE creating a draft revision", async () => {
		const result = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id: postId, data: { title: "" } },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);

		// And no draft revision was written — listing revisions returns empty.
		const list = await harness.client.callTool({
			name: "revision_list",
			arguments: { collection: "post", id: postId },
		});
		expect(list.isError, extractText(list)).toBeFalsy();
		const { items } = JSON.parse(extractText(list)) as { items: unknown[] };
		expect(items).toEqual([]);
	});
});
