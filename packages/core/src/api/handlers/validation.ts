/**
 * Field-level validation for content create / update.
 *
 * Wires the existing `generateZodSchema()` pipeline (`schema/zod-generator.ts`)
 * into the handler boundary so REST and MCP both get the same enforcement:
 *
 *  - required fields must be present and non-empty
 *  - select / multiSelect values must match the configured options
 *  - storage-less fields (reference) must not be sent in `data` at all
 *
 * Errors surface as `{ code: "VALIDATION_ERROR", message }` with all
 * offending fields listed in one message so callers can fix everything in
 * a single round trip.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { SchemaRegistry } from "../../schema/registry.js";
import { STORAGELESS_FIELD_TYPES } from "../../schema/types.js";
import { generateZodSchema } from "../../schema/zod-generator.js";

type ValidationResult =
	| { ok: true }
	| { ok: false; error: { code: "VALIDATION_ERROR" | "COLLECTION_NOT_FOUND"; message: string } };

/**
 * Format a Zod issue path into a human-readable field reference, e.g.
 * `tags`, `tags.1`, `image.alt`.
 */
function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
	if (path.length === 0) return "(root)";
	return path.map((seg) => String(seg)).join(".");
}

/**
 * Validate `data` against the collection's field definitions.
 *
 * `partial: true` switches Zod into partial mode so updates can include
 * only the fields being changed without tripping required-field errors on
 * fields the caller didn't touch. Required fields that ARE present in
 * partial-mode data still get the empty-string check below.
 */
export async function validateContentData(
	db: Kysely<Database>,
	collection: string,
	data: Record<string, unknown>,
	options: { partial?: boolean } = {},
): Promise<ValidationResult> {
	const registry = new SchemaRegistry(db);
	const collectionWithFields = await registry.getCollectionWithFields(collection);
	if (!collectionWithFields) {
		return {
			ok: false,
			error: {
				code: "COLLECTION_NOT_FOUND",
				message: `Collection '${collection}' not found`,
			},
		};
	}

	const issues: string[] = [];

	// Detect unknown keys explicitly so callers get a useful error rather
	// than silently dropped data. Leading-underscore keys (e.g. `_slug`,
	// `_rev`) are reserved for internal handler/runtime use and aren't real
	// fields; skip them.
	const knownFields = new Set(collectionWithFields.fields.map((f) => f.slug));
	const storagelessFields = new Set(
		collectionWithFields.fields
			.filter((f) => STORAGELESS_FIELD_TYPES.has(f.type))
			.map((f) => f.slug),
	);
	for (const key of Object.keys(data)) {
		if (key.startsWith("_")) continue;
		if (storagelessFields.has(key)) {
			// A storage-less field holds no value in `data` — a reference field's
			// selections are edges. Accepting the key here would validate a value
			// the write path then has nowhere to put.
			issues.push(`${key}: set this field through the entry's references endpoint, not 'data'`);
			continue;
		}
		if (!knownFields.has(key)) {
			issues.push(`${key}: unknown field on collection '${collection}'`);
		}
	}

	// Zod handles type, enum, length and missing-required (in non-partial
	// mode) checks. Empty-string handling for required string fields is
	// done as a separate pass below since Zod's `z.string()` accepts "".
	const baseSchema = generateZodSchema(collectionWithFields);
	const schema = options.partial ? baseSchema.partial() : baseSchema;
	const parsed = schema.safeParse(data);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			issues.push(`${formatIssuePath(issue.path)}: ${issue.message}`);
		}
	}

	// Empty-string-on-required check. In create mode (partial=false) Zod
	// already catches missing/null for required fields, but `z.string()`
	// happily accepts "". In update mode (partial=true) the field is only
	// checked if it's present in `data`.
	for (const field of collectionWithFields.fields) {
		if (!field.required) continue;
		const present = Object.hasOwn(data, field.slug);
		if (options.partial && !present) continue;
		if (data[field.slug] === "") {
			issues.push(`${field.slug}: required (empty value not allowed)`);
		}
	}

	if (issues.length === 0) return { ok: true };
	return {
		ok: false,
		error: {
			code: "VALIDATION_ERROR",
			message: issues.join("; "),
		},
	};
}
