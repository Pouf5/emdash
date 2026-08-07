/**
 * Bulk cross-collection duplicate endpoint - injected by EmDash integration
 *
 * POST /_emdash/api/content/{collection}/duplicate-to - Copy entries into
 * another collection through a field mapping. Returns a per-item result;
 * one item failing validation does not stop the others.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, unwrapResult } from "#api/error.js";
import { parseBody } from "#api/parse.js";
import { contentDuplicateToBody } from "#api/schemas/content.js";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals, cache }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;

	if (!emdash?.handleContentDuplicateTo) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	const denied = requirePerm(user, "content:create");
	if (denied) return denied;

	const body = await parseBody(request, contentDuplicateToBody);
	if (body instanceof Response) return body;

	// Per-item read access (and, with trashSource, delete access) is checked
	// against each entry's author inside the handler.
	const result = await emdash.handleContentDuplicateTo(collection, {
		...body,
		actor: user ? { id: user.id, role: user.role } : undefined,
	});

	if (!result.success) return unwrapResult(result);

	if (cache?.enabled) {
		const tags = [body.targetCollection];
		if (body.trashSource) tags.push(collection);
		await cache.invalidate({ tags });
	}

	return unwrapResult(result);
};
