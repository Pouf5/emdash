---
"emdash": minor
---

Enforces a reference field's `required` and `multiple` settings on the server. A field configured for a single reference now rejects a payload with more than one, and a required field rejects an empty selection or a create that omits it. Both hold wherever the edges are written — the content body, the reference endpoints, and seeds — so the constraint can't be sidestepped by picking a different entry point.
