---
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"emdash": minor
---

Adds manual ordering for taxonomy terms. Move terms up and down from the Taxonomies screen, and templates render them in that order.

Existing terms keep the order they display in today, now stored explicitly instead of derived from their labels. Terms added afterwards go to the end of their sibling group rather than slotting in alphabetically — if you want a taxonomy alphabetical, order it that way once and it stays. A term's position is shared by all of its translations, so ordering a taxonomy in one locale orders it everywhere.

Also fixes moving a term to a new parent only taking effect in the locale you moved it in, which left the term nested in that locale and still at the top level in the others. Moving a term now moves it in every locale, and terms already split this way are repaired on upgrade.
