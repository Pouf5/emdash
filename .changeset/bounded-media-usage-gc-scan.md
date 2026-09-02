---
"emdash": patch
---

Fixes the scheduled media-usage cleanup so a tick that no longer holds the cleanup lease stops immediately instead of scanning the whole occurrence table. On large sites the guarded scan previously read every occurrence in the sweep window — hundreds of thousands of rows on a table its `LIMIT` was meant to keep at a few hundred — and returned nothing. Sites on Cloudflare D1 will see the corresponding rows-read spikes disappear from cron ticks.
