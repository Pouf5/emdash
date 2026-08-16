---
"emdash": minor
---

Adds reference fields to the MCP tools. `content_create` and `content_update` take a `references` argument keyed by field slug — `{ fieldSlug: [entryIdOrSlug, ...] }`, in display order — and `content_get` returns an entry's selections under `references`, each child resolved to its id, slug and title. `schema_create_field` now creates the relation a reference field needs, so a field added over MCP can be written through immediately, and `schema_delete_field` removes that relation instead of orphaning it. A reference field sent under `data` is still rejected; nothing is silently dropped.
