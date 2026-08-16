---
"emdash": minor
---

Adds a `references` key to the content create and update bodies, so an entry's reference selections save in the same request — and the same transaction — as the entry itself. A child that fails to resolve aborts the whole save rather than leaving a half-written entry. The editor GET returns the first page of each reference field's children, duplicating an entry carries its references onto the copy, and purging the last row of a translation group clears the edges it owned.
