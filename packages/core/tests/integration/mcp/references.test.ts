/**
 * MCP reference field tools — integration tests.
 *
 * Reference selections are edges, not column values, so they travel outside
 * `data`: `content_create` / `content_update` take a `references` argument and
 * `content_get` hydrates one back, both keyed by field slug (MCP exposes no
 * relation tools, so a relation's translation group is unreachable from here).
 *
 * Every write lands through `setReferenceChildren`, which is where `multiple`
 * and `required` are enforced — these tests assert MCP reaches it rather than
 * re-checking the constraints themselves.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleSchemaFieldCreate } from "../../../src/api/handlers/schema.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";
const SUBSCRIBER_ID = "user_subscriber";

interface EntryRefShape {
	id: string;
	slug: string | null;
	title: string | null;
}

interface ReadShape {
	item: {
		id: string;
		data: Record<string, unknown>;
		references?: Record<string, { children: EntryRefShape[] }>;
	};
}

/** Create the `page` and `post` collections every test here shares. */
async function setupCollections(db: Kysely<Database>): Promise<void> {
	const registry = new SchemaRegistry(db);
	for (const slug of ["page", "post"]) {
		await registry.createCollection({ slug, label: slug });
		await registry.createField(slug, {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
	}
}

async function addReferenceField(
	db: Kysely<Database>,
	input: { slug: string; label: string; multiple?: boolean; required?: boolean },
): Promise<void> {
	const result = await handleSchemaFieldCreate(db, "post", {
		slug: input.slug,
		label: input.label,
		type: "reference",
		required: input.required,
		validation: { targetCollection: "page", multiple: input.multiple },
	});
	if (!result.success) throw new Error(result.error.message);
}

// ---------------------------------------------------------------------------
// Writing and reading selections
// ---------------------------------------------------------------------------

describe("MCP references — content_create / content_update / content_get", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;
	let pageIds: string[];

	async function createPage(title: string): Promise<string> {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "page", data: { title } },
		});
		return extractJson<{ item: { id: string } }>(result).item.id;
	}

	async function readReferences(postId: string): Promise<ReadShape["item"]> {
		const read = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: postId },
		});
		expect(read.isError, extractText(read)).toBeFalsy();
		return extractJson<ReadShape>(read).item;
	}

	beforeEach(async () => {
		db = await setupTestDatabase();
		await setupCollections(db);
		await addReferenceField(db, { slug: "related", label: "Related", multiple: true });

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		pageIds = [await createPage("First"), await createPage("Second")];
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("keeps the order the selection was sent in", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Ordered" },
				references: { related: [pageIds[1], pageIds[0]] },
			},
		});
		expect(created.isError, extractText(created)).toBeFalsy();

		const item = await readReferences(extractJson<{ item: { id: string } }>(created).item.id);
		expect(item.references?.related.children.map((c) => c.id)).toEqual([pageIds[1], pageIds[0]]);
	});

	it("resolves a child by slug as well as by id", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "By slug" },
				references: { related: ["first"] },
			},
		});
		expect(created.isError, extractText(created)).toBeFalsy();

		const item = await readReferences(extractJson<{ item: { id: string } }>(created).item.id);
		expect(item.references?.related.children.map((c) => c.id)).toEqual([pageIds[0]]);
	});

	it("replaces the selection on update and clears it with an empty array", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Replaceable" },
				references: { related: [pageIds[0]] },
			},
		});
		const postId = extractJson<{ item: { id: string } }>(created).item.id;

		const replaced = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id: postId, references: { related: [pageIds[1]] } },
		});
		expect(replaced.isError, extractText(replaced)).toBeFalsy();
		expect((await readReferences(postId)).references?.related.children.map((c) => c.id)).toEqual([
			pageIds[1],
		]);

		const cleared = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id: postId, references: { related: [] } },
		});
		expect(cleared.isError, extractText(cleared)).toBeFalsy();
		expect((await readReferences(postId)).references?.related.children).toEqual([]);
	});

	it("carries the selection through a create that publishes in one call", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Published" },
				status: "published",
				references: { related: [pageIds[0]] },
			},
		});
		expect(created.isError, extractText(created)).toBeFalsy();

		const item = await readReferences(extractJson<{ item: { id: string } }>(created).item.id);
		expect(item.references?.related.children.map((c) => c.id)).toEqual([pageIds[0]]);
	});

	it("carries the selection through an update that publishes in one call", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Draft first" } },
		});
		const postId = extractJson<{ item: { id: string } }>(created).item.id;

		const published = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id: postId,
				status: "published",
				references: { related: [pageIds[0]] },
			},
		});
		expect(published.isError, extractText(published)).toBeFalsy();
		expect((await readReferences(postId)).references?.related.children.map((c) => c.id)).toEqual([
			pageIds[0],
		]);
	});

	it("returns an empty selection for a field that was never set", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Bare" } },
		});

		const item = await readReferences(extractJson<{ item: { id: string } }>(created).item.id);
		expect(item.references?.related.children).toEqual([]);
	});

	it("names the collection's reference fields when the key isn't one", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Typo" },
				references: { relatd: [pageIds[0]] },
			},
		});

		expect(created.isError).toBe(true);
		const text = extractText(created);
		expect(text).toContain("relatd");
		expect(text).toContain("related");
	});

	it("rejects a child that doesn't exist in the target collection", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Dangling" },
				references: { related: ["01NOTAREALPAGE"] },
			},
		});

		expect(created.isError).toBe(true);
		expect(extractText(created)).toContain("01NOTAREALPAGE");
	});

	it("leaves no entry behind when a child fails to resolve", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Rolled back" },
				references: { related: ["01NOTAREALPAGE"] },
			},
		});
		expect(created.isError).toBe(true);

		const list = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post" },
		});
		expect(extractJson<{ items: unknown[] }>(list).items).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Field constraints reach MCP writes
// ---------------------------------------------------------------------------

describe("MCP references — field constraints", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await setupCollections(db);
		await addReferenceField(db, { slug: "parent_page", label: "Parent Page" });
		await addReferenceField(db, {
			slug: "primary_page",
			label: "Primary Page",
			required: true,
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	async function createPages(): Promise<string[]> {
		const ids: string[] = [];
		for (const title of ["One", "Two"]) {
			const result = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "page", data: { title } },
			});
			ids.push(extractJson<{ item: { id: string } }>(result).item.id);
		}
		return ids;
	}

	it("rejects two children on a single-value field", async () => {
		const pages = await createPages();
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Too many" },
				references: { primary_page: [pages[0]], parent_page: pages },
			},
		});

		expect(created.isError).toBe(true);
		expect(extractText(created)).toContain("parent_page");
	});

	it("rejects a create that omits a required reference field", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Missing" } },
		});

		expect(created.isError).toBe(true);
		expect(extractText(created)).toContain("primary_page");
	});
});

// ---------------------------------------------------------------------------
// Draft children stay hidden from callers without draft access
// ---------------------------------------------------------------------------

describe("MCP references — draft visibility", () => {
	let db: Kysely<Database>;
	let admin: McpHarness;
	let subscriber: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await setupCollections(db);
		await addReferenceField(db, { slug: "related", label: "Related", multiple: true });

		admin = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		subscriber = await connectMcpHarness({
			db,
			userId: SUBSCRIBER_ID,
			userRole: Role.SUBSCRIBER,
		});
	});

	afterEach(async () => {
		if (admin) await admin.cleanup();
		if (subscriber) await subscriber.cleanup();
		await teardownTestDatabase(db);
	});

	it("skips a draft child for a reader who can't see drafts", async () => {
		const draftPage = await admin.client.callTool({
			name: "content_create",
			arguments: { collection: "page", data: { title: "Unannounced" } },
		});
		const draftPageId = extractJson<{ item: { id: string } }>(draftPage).item.id;

		const post = await admin.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Live post" },
				status: "published",
				references: { related: [draftPageId] },
			},
		});
		const postId = extractJson<{ item: { id: string } }>(post).item.id;

		const asAdmin = await admin.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: postId },
		});
		expect(extractJson<ReadShape>(asAdmin).item.references?.related.children).toHaveLength(1);

		const asSubscriber = await subscriber.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: postId },
		});
		const children = extractJson<ReadShape>(asSubscriber).item.references?.related.children;
		expect(children).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// schema_create_field / schema_delete_field own the relation behind the field
// ---------------------------------------------------------------------------

describe("MCP references — schema tools", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await setupCollections(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	async function createPage(): Promise<string> {
		const page = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "page", data: { title: "Target" } },
		});
		return extractJson<{ item: { id: string } }>(page).item.id;
	}

	/**
	 * Write `pageId` through the `parent_page` field and read it back. Asserting
	 * only that the write returned no error would pass against a field whose
	 * relation was never created — the selection is dropped, not rejected.
	 */
	async function expectWritableReference(pageId: string): Promise<void> {
		const post = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Child" },
				references: { parent_page: [pageId] },
			},
		});
		expect(post.isError, extractText(post)).toBeFalsy();

		const read = await harness.client.callTool({
			name: "content_get",
			arguments: {
				collection: "post",
				id: extractJson<{ item: { id: string } }>(post).item.id,
			},
		});
		const children = extractJson<ReadShape>(read).item.references?.parent_page.children;
		expect(children?.map((c) => c.id)).toEqual([pageId]);
	}

	it("creates a reference field content_create can immediately write through", async () => {
		const field = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "parent_page",
				label: "Parent Page",
				type: "reference",
				validation: { targetCollection: "page" },
			},
		});
		expect(field.isError, extractText(field)).toBeFalsy();

		await expectWritableReference(await createPage());
	});

	it("accepts the target collection as the widget option it has always documented", async () => {
		const field = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "parent_page",
				label: "Parent Page",
				type: "reference",
				options: { collection: "page" },
			},
		});
		expect(field.isError, extractText(field)).toBeFalsy();

		await expectWritableReference(await createPage());
	});

	it("rejects a reference field with no target collection", async () => {
		const field = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "parent_page",
				label: "Parent Page",
				type: "reference",
			},
		});

		expect(field.isError).toBe(true);
		expect(extractText(field)).toContain("target collection");
	});

	it("takes the relation with the field when the field is deleted", async () => {
		await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "parent_page",
				label: "Parent Page",
				type: "reference",
				validation: { targetCollection: "page" },
			},
		});
		expect(await new RelationRepository(db).list()).toHaveLength(1);

		const deleted = await harness.client.callTool({
			name: "schema_delete_field",
			arguments: { collection: "post", fieldSlug: "parent_page" },
		});
		expect(deleted.isError, extractText(deleted)).toBeFalsy();

		expect(await new RelationRepository(db).list()).toEqual([]);
	});
});
