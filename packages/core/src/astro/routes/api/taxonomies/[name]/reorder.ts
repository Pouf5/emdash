/**
 * Taxonomy term reorder endpoint
 *
 * POST /_emdash/api/taxonomies/:name/reorder[?locale=xx]
 *   body: { parentId?, ids }
 *
 * Sets the manual order of one sibling group. `ids` must be that group's exact
 * membership in the desired order; anything else is REORDER_MISMATCH (400).
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleTermReorder } from "#api/handlers/taxonomies.js";
import { isParseError, parseBody, parseQuery } from "#api/parse.js";
import { localeFilterQuery, reorderTermsBody } from "#api/schemas.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { name } = params;
	if (!name) return apiError("VALIDATION_ERROR", "Taxonomy name required", 400);

	const dbErr = requireDb(emdash?.db);
	if (dbErr) return dbErr;

	const denied = requirePerm(user, "taxonomies:manage");
	if (denied) return denied;

	const query = parseQuery(new URL(request.url), localeFilterQuery);
	if (isParseError(query)) return query;

	try {
		const body = await parseBody(request, reorderTermsBody);
		if (isParseError(body)) return body;

		const result = await handleTermReorder(emdash.db, name, body, { locale: query.locale });
		return unwrapResult(result);
	} catch (error) {
		return handleError(error, "Failed to reorder terms", "TERM_REORDER_ERROR");
	}
};
