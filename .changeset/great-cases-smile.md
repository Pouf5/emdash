---
"emdash": patch
---

Fixes taxonomy term counts reading a near-quadratic number of database rows on larger sites. The count query drove from the content table and re-checked the taxonomy's entire term list once per entry, so the cost scaled with entries × terms — on a site with ~26k entries and ~1.4k terms a single call read ~35.6M rows and took ~29s, on every page that renders a term list or taxonomy filter. It now seeks the terms on the `content_taxonomies` index and touches content rows only by primary key: the same call reads ~64k rows in ~120ms. Counts are unchanged.
