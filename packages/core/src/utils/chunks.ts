/**
 * Split an array into chunks of at most `size` elements.
 *
 * Used to keep SQL `IN (?, ?, …)` clauses within Cloudflare D1's
 * bound-parameter limit (~100 per statement).
 */
export function chunks<T>(arr: T[], size: number): T[][] {
	if (arr.length === 0) return [];
	const result: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		result.push(arr.slice(i, i + size));
	}
	return result;
}

/** Conservative default chunk size for SQL IN clauses (well within D1's limit). */
export const SQL_BATCH_SIZE = 50;

/**
 * Maximum number of terms one compound SELECT (`UNION ALL`, `INTERSECT`,
 * `EXCEPT`) may have. SQLite's own default is 500, but Cloudflare D1 sets
 * SQLITE_LIMIT_COMPOUND_SELECT to 5 and rejects anything larger with
 * "too many terms in compound SELECT". Split into separate statements past it.
 */
export const SQL_COMPOUND_SELECT_LIMIT = 5;
