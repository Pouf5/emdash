import { z } from "astro/zod";

import type { FieldDefinition } from "./types.js";

/**
 * Reference field
 *
 * Links to entries in `collection`. The selections are edges, not a column, so
 * they never appear in `entry.data` — read them from `entry.references[slug]`,
 * where each is a `ReferencedEntry` carrying the target's own `data`:
 *
 * ```ts
 * const { entry } = await getEmDashEntry("posts", slug);
 * for (const related of entry.references.related_posts ?? []) {
 *   related.data.title;
 * }
 * ```
 */
export function reference(
	collection: string,
	options?: {
		required?: boolean;
	},
): FieldDefinition<never> {
	const schema = z.string();

	return {
		type: "reference",
		columnType: "TEXT",
		schema: options?.required === false ? schema.optional() : schema,
		options: {
			...options,
			collection,
		},
		ui: {
			widget: "reference",
		},
	};
}
