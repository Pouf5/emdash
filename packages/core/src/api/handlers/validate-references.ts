import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { requestCached } from "../../request-cache.js";
import { STORAGELESS_FIELD_TYPES } from "../../schema/types.js";
import type { ApiResult } from "../types.js";

/** A storage-less field's row: no column, so no value of its own in `data`. */
export interface StoragelessField {
	slug: string;
	type: string;
	required: number;
	validation: string | null;
}

/** A reference field's constraints, resolved from its stored validation JSON. */
export interface ReferenceFieldConfig {
	slug: string;
	relation: string;
	targetCollection: string;
	multiple: boolean;
	required: boolean;
}

function fail(message: string): ApiResult<never> {
	return { success: false, error: { code: "VALIDATION_ERROR", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The storage-less fields on `collection` (see `STORAGELESS_FIELD_TYPES`).
 * Memoized for the request: one lookup serves the read-side `data` strip,
 * reference hydration, and constraint checks alike.
 */
export function storagelessFields(
	db: Kysely<Database>,
	collection: string,
): Promise<StoragelessField[]> {
	return requestCached(`storageless-fields:${collection}`, async () => {
		return db
			.selectFrom("_emdash_fields")
			.innerJoin("_emdash_collections", "_emdash_collections.id", "_emdash_fields.collection_id")
			.select([
				"_emdash_fields.slug",
				"_emdash_fields.type",
				"_emdash_fields.required",
				"_emdash_fields.validation",
			])
			.where("_emdash_collections.slug", "=", collection)
			.where("_emdash_fields.type", "in", [...STORAGELESS_FIELD_TYPES])
			.execute();
	});
}

/**
 * The reference fields on `collection`, keyed by the relation they back.
 *
 * A relation with no entry here is not an error: relations exist independently
 * of fields (the relations API can create one directly), and those carry no
 * `multiple` or `required` config to enforce. A reference field missing
 * `relation` or `targetCollection` is a legacy field and is skipped for the
 * same reason.
 */
export async function referenceFieldsByRelation(
	db: Kysely<Database>,
	collection: string,
): Promise<Map<string, ReferenceFieldConfig>> {
	const fields = await storagelessFields(db, collection);
	const configs = new Map<string, ReferenceFieldConfig>();

	for (const field of fields) {
		if (field.type !== "reference" || !field.validation) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(field.validation);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;

		const relation = typeof parsed.relation === "string" ? parsed.relation : undefined;
		const targetCollection =
			typeof parsed.targetCollection === "string" ? parsed.targetCollection : undefined;
		if (!relation || !targetCollection) continue;

		configs.set(relation, {
			slug: field.slug,
			relation,
			targetCollection,
			multiple: parsed.multiple === true,
			required: field.required === 1,
		});
	}

	return configs;
}

/**
 * Check one reference field's selection against its own definition.
 *
 * Called from `setReferenceChildren`, the single choke point every edge write
 * passes through, so the constraints hold for the content body, the standalone
 * edge endpoint and the seed engine without three separate checks to keep in
 * step.
 */
export function validateReferenceSelection(
	config: ReferenceFieldConfig,
	childIds: string[],
): ApiResult<true> {
	if (!config.multiple && childIds.length > 1) {
		return fail(
			`Field '${config.slug}' accepts a single reference, received ${childIds.length}. ` +
				`Set multiple on the field to select more than one.`,
		);
	}
	if (config.required && childIds.length === 0) {
		return fail(`Field '${config.slug}' is required and must reference at least one entry.`);
	}
	return { success: true, data: true };
}

/**
 * Check that every required reference field on `collection` is present in a
 * create payload. Selections that ARE present are checked per-field on write;
 * this catches the field the payload leaves out entirely, which no edge write
 * would otherwise visit.
 *
 * Updates don't call this: an update that doesn't mention a field leaves it
 * alone, the same partial semantics a required column-backed field gets.
 */
export async function validateRequiredReferencesPresent(
	db: Kysely<Database>,
	collection: string,
	references: Record<string, string[]> | undefined,
): Promise<ApiResult<true>> {
	const configs = await referenceFieldsByRelation(db, collection);

	for (const config of configs.values()) {
		if (!config.required) continue;
		if (references && Object.hasOwn(references, config.relation)) continue;
		return fail(`Field '${config.slug}' is required and must reference at least one entry.`);
	}

	return { success: true, data: true };
}
