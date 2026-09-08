---
"emdash": patch
---

Fixes media-usage cleanup reading the entire backlog on every run instead of only the rows it cleans, which made the scheduled cleanup task steadily more expensive as a site's backlog grew.
