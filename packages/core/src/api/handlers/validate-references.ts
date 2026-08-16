import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { referenceFields, type ReferenceFieldConfig } from "../../schema/reference-fields.js";
import type { ApiResult } from "../types.js";

function fail(message: string): ApiResult<never> {
	return { success: false, error: { code: "VALIDATION_ERROR", message } };
}

/**
 * The reference fields on `collection`, keyed by the relation they back.
 *
 * A relation with no entry here is not an error: relations exist independently
 * of fields (the relations API can create one directly), and those carry no
 * `multiple` or `required` config to enforce.
 */
export async function referenceFieldsByRelation(
	db: Kysely<Database>,
	collection: string,
): Promise<Map<string, ReferenceFieldConfig>> {
	const configs = await referenceFields(db, collection);
	return new Map(configs.map((config) => [config.relation, config]));
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
	for (const config of await referenceFields(db, collection)) {
		if (!config.required) continue;
		if (references && Object.hasOwn(references, config.relation)) continue;
		return fail(`Field '${config.slug}' is required and must reference at least one entry.`);
	}

	return { success: true, data: true };
}
