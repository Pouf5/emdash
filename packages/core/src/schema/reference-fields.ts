/**
 * Reading a collection's storage-less fields.
 *
 * A storage-less field has no column, so nothing about it can be read off a
 * content row — every consumer (the `data` strip, reference hydration,
 * constraint checks) has to ask the schema instead. They all come through here
 * so a single request pays for one lookup.
 */

import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { getDb } from "../loader.js";
import { cachedQuery, CacheNamespace } from "../object-cache/index.js";
import { requestCached } from "../request-cache.js";
import { STORAGELESS_FIELD_TYPES } from "./types.js";

/** A storage-less field's row: no column, so no value of its own in `data`. */
export interface StoragelessField {
	slug: string;
	type: string;
	required: number;
	validation: string | null;
}

/** A reference field's target and constraints, resolved from its validation JSON. */
export interface ReferenceFieldConfig {
	slug: string;
	relation: string;
	targetCollection: string;
	multiple: boolean;
	required: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The storage-less fields on `collection`, memoized for the request.
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
 * Resolve reference fields from storage-less field rows.
 *
 * A field missing `relation` or `targetCollection` is a legacy field with no
 * edges behind it, and is skipped rather than half-resolved.
 */
export function toReferenceFieldConfigs(fields: StoragelessField[]): ReferenceFieldConfig[] {
	const configs: ReferenceFieldConfig[] = [];

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

		configs.push({
			slug: field.slug,
			relation,
			targetCollection,
			multiple: parsed.multiple === true,
			required: field.required === 1,
		});
	}

	return configs;
}

/** The reference fields on `collection`, memoized for the request. */
export async function referenceFields(
	db: Kysely<Database>,
	collection: string,
): Promise<ReferenceFieldConfig[]> {
	return toReferenceFieldConfigs(await storagelessFields(db, collection));
}

/**
 * The reference fields on `collection` for the public read path, backed by the
 * distributed schema cache.
 *
 * Public reads hydrate references unconditionally, so a collection with none
 * must not pay a round trip per render to discover that. Schema mutations
 * already bust `CacheNamespace.SCHEMA`, so the cached answer follows a field
 * being added or removed.
 */
export function getReferenceFields(collection: string): Promise<ReferenceFieldConfig[]> {
	return requestCached(`reference-fields:${collection}`, () =>
		cachedQuery({
			namespace: CacheNamespace.SCHEMA,
			key: `reference-fields:${collection}`,
			load: async () => referenceFields(await getDb(), collection),
		}),
	);
}
