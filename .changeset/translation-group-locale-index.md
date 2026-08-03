---
"emdash": patch
---

Fixes translation lookups reading every non-deleted row of a content table. Content tables now carry a `(translation_group, locale)` index, replacing the single-column `translation_group` one, so fetching an entry's translations seeks straight to its group instead of scanning. The improvement is largest on big collections and on D1, where the query planner has no statistics to fall back on.
