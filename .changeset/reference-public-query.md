---
"emdash": minor
---

Exposes reference fields to `getEmDashEntry` and `getEmDashCollection` as `entry.references`, keyed by field slug. Each referenced entry carries its own `data`, so a template can render a related entry's title, slug or image without another query. Published targets only, resolved in the reading entry's locale where a variant exists. Generated types no longer describe a reference field as a string on `data` — it never held one.
