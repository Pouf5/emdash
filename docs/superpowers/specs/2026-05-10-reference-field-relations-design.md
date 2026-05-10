---
date: 2026-05-10
discussion: https://github.com/emdash-cms/emdash/discussions/386
status: approved-for-implementation
title: Reference field as bidirectional relation
---

# Reference field as bidirectional relation

## Background

The `reference` field type exists as a recognized type throughout the codebase but the admin UI was never built out. The original discussion #386 proposed three concrete UI fixes (collection picker in `FieldEditor`, content picker in `ContentEditor`, `isReference` flag in the static helper). The discussion comments evolved the scope toward a join-table architecture with backlinks. This spec covers the larger redesign, which makes a single user-facing change ("reference fields work and are bidirectional") rather than shipping a half-step that would have to be redesigned again.

## Resolved design questions

| Question | Decision |
|---|---|
| Spec scope | Full join-table redesign (not UI-only). |
| Cardinality | Single + multi from day one. `allowMultiple` per side. |
| Reciprocal back-field | Always reciprocal. Creating a reference field on collection A always creates a paired field on collection B. |
| Self-relations | Allowed (e.g. `parent`/`children` on the same collection). |
| Backlinks UX | Always exposed as the reciprocal field on the other side; no separate "Referenced by" sidebar. |
| Delete behavior | Trash hides links; permanent delete removes them. Trashed items don't appear as active references but are recoverable. The delete dialog lists every affected source. |
| Migration of existing data | Convert `type='reference'` rows to `type='text'`; keep raw values as strings (no agreed-upon format to interpret). |
| i18n | Store target by `translation_group`. References auto-resolve to source's locale at read time, with fallback. |
| Naming | `reciprocal_field_id` (DB) / `reciprocalFieldId` (TS). |
| `allowMultiple` enforcement | Write-time validation only, like other field-validation rules. No DB-level cardinality constraint. |
| Approach | Reuse the `reference` field type, redesign internals. Static `reference()` helper throws — never functional, no compatibility burden. |

## Section 1 — Storage model

A new system table `_emdash_references` holds every link. Each link is one row, accessed symmetrically from either side. No source/target asymmetry — the two endpoints are "A" and "B" and which-is-which is decided by the relation definition, not the row.

```sql
CREATE TABLE _emdash_references (
  id                       TEXT PRIMARY KEY,         -- ULID
  field_a_id               TEXT NOT NULL,            -- FK _emdash_fields(id)
  field_b_id               TEXT NOT NULL,            -- FK _emdash_fields(id)
  endpoint_a_collection    TEXT NOT NULL,            -- ec_* slug (denormalized for query speed)
  endpoint_a_group         TEXT NOT NULL,            -- translation_group on A side
  endpoint_b_collection    TEXT NOT NULL,            -- ec_* slug
  endpoint_b_group         TEXT NOT NULL,            -- translation_group on B side
  position_a               INTEGER NOT NULL,         -- ordering when displayed from A's editor
  position_b               INTEGER NOT NULL,         -- ordering when displayed from B's editor
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Indexes** (forward-only, all required at table creation):

- `idx_refs_a` on `(field_a_id, endpoint_a_group, position_a)` — driving lookup when rendering A's editor.
- `idx_refs_b` on `(field_b_id, endpoint_b_group, position_b)` — driving lookup when rendering B's editor.
- `idx_refs_a_target` on `(field_a_id, endpoint_b_group)` — backlinks from B to A.
- `idx_refs_b_target` on `(field_b_id, endpoint_a_group)` — symmetric.
- **Static dedupe** `UNIQUE(field_a_id, endpoint_a_group, endpoint_b_group)` — prevents the same A↔B link from being inserted twice in the same relation. Holds regardless of `allowMultiple`.

**No cardinality UNIQUE indexes.** `allowMultiple` is a write-time validation rule, not a DB constraint. See §2.

**Self-references** (`endpoint_a_collection = endpoint_b_collection`) are allowed. The two field IDs differ (e.g. `parent` vs `children` on Pages), so the lookup indexes naturally distinguish the two directions. The application layer rejects rows where `endpoint_a_group = endpoint_b_group` (no self-loop) on insert — checked in handlers, not as a SQL CHECK constraint, so error messages can be localized.

**Why `translation_group`, not `id`:** all queries against this table identify endpoints by their stable group identifier. Translating a content row creates a new `id` but reuses the group, so the link survives translation transparently. Resolution to a concrete row happens at read time by joining with the target `ec_*` table on `(translation_group, locale)`, falling back to the site's default locale when no translation exists. Full rules in §6.1.

## Section 2 — Schema-registry pair model

Two reference fields are the two halves of one relation. They must know about each other, and a single source of truth is needed for cardinality and target collection on each side.

**No new system table for relations.** Pairing is stored as columns on existing `_emdash_fields` rows:

| Concept | Storage |
|---|---|
| Reciprocal pair pointer | `_emdash_fields.reciprocal_field_id` (column, indexed) |
| Target collection | `_emdash_fields.target_collection_id` (column, indexed, FK to `_emdash_collections.id`) |
| `allowMultiple` | `_emdash_fields.validation.allowMultiple` (JSON, write-time validation only) |
| Per-link rows | `_emdash_references` (§1) |
| Dedupe | `UNIQUE(field_a_id, endpoint_a_group, endpoint_b_group)` (DB) |
| No self-loop | App-level check in handler |

Both sides hold a `reciprocal_field_id` pointing at each other. Either side can answer "what's the target collection?" and "is this many or one?" without consulting the other row, keeping reads cheap. The reciprocal is consulted only when we need the *other* side's cardinality.

**Why columns and not JSON.** `reciprocal_field_id` is a foreign key to another field row — burying it in JSON makes orphan detection a string scan and "which fields point at collection X?" a JSON-extract over every row. Both lookups happen on schema edits, trash, and restore (cold paths but not instant either). `allowMultiple` stays in JSON because it's read once when validating a write — it's not queried by other code.

**No SQL FK on `reciprocal_field_id`.** Creating a pair atomically requires inserting one row before its mate exists. The invariant is enforced by the schema-registry layer in transactions. SQL FK on `target_collection_id` → `_emdash_collections.id` is fine and is added.

**Invariants enforced by the schema-registry layer:**

1. If field X has `reciprocal_field_id = Y`, then field Y must have `reciprocal_field_id = X`.
2. Field X's `target_collection_id` equals field Y's `collection_id`, and vice versa.
3. Both fields' types are `reference`.
4. Self-relation: X and Y may have the same `collection_id` but must have distinct `id`s and distinct `slug`s.

**`createReferencePair`** (new schema-registry method, transactional):

1. Validate target collection exists.
2. Validate the proposed reciprocal slug doesn't collide with an existing field on the target.
3. Validate slugs differ when target equals source collection (no `parent`/`parent`).
4. Insert two `_emdash_fields` rows in one transaction: first with placeholder `reciprocal_field_id`, second with the first's id, then `UPDATE` the first to set its `reciprocal_field_id`.
5. **No `ALTER TABLE` on the `ec_*` tables.** Reference fields no longer occupy a column — this is the key behavioral change from the existing `addField` path, which always adds a column.

**`deleteReferencePair`:**

1. Delete all rows in `_emdash_references` matching either field id (cascade is application-level — keeps the option open to handle cross-DB deletion semantics consistently).
2. Delete both `_emdash_fields` rows.
3. Either side's "delete field" UI invokes this — deleting one half always deletes the mate. The confirmation dialog says so explicitly.

**`updateReferencePair`** (label, `required`, `allowMultiple`):

- Editing label and `required` is independent per side.
- Editing `allowMultiple` does **not** validate existing data (per §2 design decision: validation runs on the next write, like other field-validation rules). A small UI advisory before saving informs the user how many rows currently violate the proposed setting (§4.1).
- Target collection cannot change without deleting and recreating the pair. The UI surfaces this explicitly.

## Section 3 — Server API surface

### 3.1 Read enrichment

`GET /content/{collection}/{id}` keeps its existing `{ item }` envelope. For reference fields, `item.data[fieldSlug]` becomes an array of resolved targets:

```ts
type ResolvedReference = {
	groupId: string;     // endpoint_*_group from the join table — stable identifier
	id: string;          // resolved row id in the target's ec_* table for the source's locale
	title: string;       // best-available title (data.title || data.name || slug || id)
	slug: string | null;
	status: "draft" | "published" | "published_with_changes";
	locale: string;      // the locale the resolution actually landed on (may differ from source)
};
```

Single-cardinality fields still return an array of length 0 or 1 — the shape is uniform regardless of `allowMultiple`. Toggling the validation flag never breaks consumers.

Locale resolution at read time joins `_emdash_references` × target `ec_*` on `translation_group = endpoint_X_group`, picking one row per group with `ORDER BY (locale = source_locale) DESC, (locale = default_locale) DESC, locale ASC LIMIT 1`. Trashed targets (`deleted_at IS NOT NULL`) are filtered out — links to currently-trashed items disappear from reads but join rows survive. Full rules in §6.1.

### 3.2 List endpoint stays unchanged

`GET /content/{collection}` does not enrich reference fields. List views don't render them, and N items × M reference fields × per-field locale-resolution is unjustifiable per-row work.

### 3.3 Write reconciliation

`POST /content/{collection}` and `PUT /content/{collection}/{id}` accept reference fields in `data` as `string[]` of target `translation_group`s. Single-cardinality also accepts a bare `string` for ergonomics; server normalizes to array. Inside the existing `withTransaction` block:

1. Fetch current `_emdash_references` rows for `(field_id, source_group)`.
2. Diff against desired list (preserving order from the request).
3. Delete removed rows, insert added rows (with new `position_*`), update `position_*` on retained rows.
4. Validate before each insert: `allowMultiple=false` cardinality on both sides, no self-loop, target group exists with at least one live row.

If validation fails the transaction rolls back — typed-column writes don't partially apply.

### 3.4 Incoming-references endpoint (new)

`GET /content/{collection}/{id}/incoming-references` powers the trash and permanent-delete confirmation dialogs. Same shape for both delete modes — the dialog text changes, the data doesn't.

```json
{
  "groups": [
    {
      "fieldId": "fld_abc",
      "fieldSlug": "chapter",
      "fieldLabel": "Chapter",
      "viaCollection": "chapters",
      "items": [
        { "groupId": "...", "id": "...", "title": "Chapter 1", "slug": "chapter-1", "locale": "en" }
      ],
      "more": 0
    }
  ],
  "totalCount": 1
}
```

Capped at 25 items per group with `more` reporting any overflow — preserves dialog readability. `totalCount` surfaces the headline number across all groups.

### 3.5 Trash and permanent-delete semantics

- **Trash** (`POST /content/{collection}/{id}/trash`, existing): sets `deleted_at`, does **not** touch `_emdash_references`. Read enrichment filters out trashed targets. Restore brings them back automatically.
- **Permanent delete** (`DELETE /content/{collection}/{id}/permanent`, existing): runs in a transaction. If this is the last live row in its `translation_group` (no other rows in this `ec_*` table share the group with `deleted_at IS NULL`), delete all `_emdash_references` rows where this group appears at either endpoint. Otherwise leave the join rows alone — the link still resolves via surviving locales.

### 3.6 Picker target listing

No new endpoint. `ContentPickerModal` uses `GET /content/{collection}` with two query params:

- `groupBy=translation_group` — returns one row per group, picked per §6.1 (new param).
- `locale={source_locale}` — hint for the per-group resolution (existing param, semantics extended).

The reference-field flow filters the source item out client-side to prevent self-loops.

### 3.7 Cardinality-impact endpoint (new)

`GET /schema/fields/{id}/cardinality-impact` returns `{ violatingSourceCount: number }` — the number of source items whose current reference rows for this field exceed cardinality 1. Powers the "are you sure?" dialog when flipping `allowMultiple` from `true` → `false` (§4.1). Implemented as `SELECT COUNT(*) FROM (SELECT endpoint_X_group FROM _emdash_references WHERE field_X_id = ? GROUP BY endpoint_X_group HAVING COUNT(*) > 1)`. Read-only; no body, no side effects.

### 3.8 Authorization

Reference writes inherit the source content item's permissions via the existing `requireOwnerPerm(user, sourceItem.authorId, "content:edit_own", "content:edit_any")` on the parent endpoint. The `incoming-references` endpoint requires read on the source's collection (drafts gate already in place). The `cardinality-impact` endpoint requires `schema:manage` (matches other schema-editing routes). **No new permission strings.**

## Section 4 — Admin UI

### 4.1 FieldEditor pair-creation flow

When the user selects "Reference" as the field type, step 2 (config) replaces all existing per-type validation panels with a pair-aware form:

```
┌─ Target collection ──────────────────────────┐
│ [Select: Chapters ▾]                         │
└──────────────────────────────────────────────┘

┌─ This collection (Lessons) ──────────────────┐
│ Label: [Chapter         ]                    │
│ Slug:  [chapter         ]  (locked on edit)  │
│ Cardinality: ( • ) One   ( ) Many            │
│ ☐ Required                                   │
└──────────────────────────────────────────────┘

         creates the reciprocal field on Chapters:

┌─ On Chapters ────────────────────────────────┐
│ Label: [Lessons         ]                    │
│ Slug:  [lessons         ]  (locked on edit)  │
│ Cardinality: ( ) One   ( • ) Many            │
│ ☐ Required                                   │
└──────────────────────────────────────────────┘

Preview: Each Lesson has one Chapter. Each Chapter has many Lessons.
                              [Cancel]  [Add Field]
```

**Defaults & auto-fill.**
- Reciprocal slug defaults from the source collection's `labelSingular`, lowercased and slugified (`Lesson` → `lesson`); flips to plural via a small `pluralize(slug)` helper when the reciprocal cardinality is "many". English-only slug pluralization is fine — slugs are ASCII identifiers.
- Reciprocal label mirrors the slug-to-label conversion.
- The "Preview" sentence is `t`-translated using the labels and cardinalities — gives the user immediate feedback.

**Validation before save** (admin-side; server re-validates):
- Reciprocal slug doesn't collide with existing field slugs on the target collection.
- Reciprocal slug doesn't equal this side's slug when target is the same collection.
- Both labels are non-empty.

**Edit mode.** Opening an existing reference field shows the same form with:
- Target collection: read-only with help text "To change the target, delete and recreate the field."
- Slug: read-only on both sides (existing rule).
- Label, cardinality, required: editable on either side.
- Editing this side's pane updates this field; switching to "Edit reciprocal" navigates to the target collection's schema editor and opens its `FieldEditor` on that field. We don't try to render both sides as one editable form once they exist.

**Cardinality flip warning.** When the user toggles `allowMultiple` from `true` → `false` on a side, the editor calls `GET /schema/fields/{id}/cardinality-impact` (new) which returns `{ violatingSourceCount: number }`. If non-zero, the dialog shows: "X items currently have multiple references. Saving won't remove them, but next time you save those items they'll fail validation until reduced to one." User can proceed or cancel.

### 4.2 ContentEditor reference widget

A new `ReferenceField` component at `packages/admin/src/components/ReferenceField.tsx`, wired into `ContentEditor`'s `FieldRenderer` switch as `case "reference":`.

**Single cardinality** (`allowMultiple=false`):
- Empty: a single full-width row with target-collection icon + "No chapter selected" + a "Pick chapter" button on the end.
- Filled: a card showing title, slug, status badge, locale badge (when the resolution fell back to a non-source locale), with `Change` and `Clear` ghost-square actions.

**Multi cardinality** (`allowMultiple=true`):
- List of cards, each with a drag handle (Phosphor `DotsSixVertical`), title, slug, status badge, locale badge, and `Remove`. Drag-to-reorder updates the appropriate `position_*` on submit. Up/down arrow keys when focused move the row for keyboard a11y.
- "Add reference" button below the list — opens the picker.
- Empty state: a centered "No chapters selected" with the "Add reference" CTA.

**Status badges** map to existing `getDraftStatus` colors. **Locale badge** appears only when `resolvedLocale !== sourceLocale` and reads `t`Resolved from ${resolvedLocale}` ` so the editor knows the link fell back.

**Click target.** Clicking the card body (not the buttons) navigates to the target item via `RouterLinkButton` semantics. Cmd-click opens in a new tab because the card body is a real anchor wrapping the title.

**No locale toggle in the widget.** Even though references resolve via translation_group, the editor only displays the resolved row's title/slug from the source's locale (or fallback). The user is editing a single locale's view, not a group-level relation manager.

### 4.3 ContentPickerModal extension

Two new optional props on the existing modal:

- `lockedCollection?: string` — when set, hides the collection `<Select>` and skips the `fetchCollections` query.
- `excludeGroups?: string[]` — translation_groups filtered out client-side. Used to suppress the source item itself.

`onSelect` signature stays the same. When `lockedCollection` is set the modal mounts with that as the initial collection and never re-renders the selector.

The reference-field flow also passes `groupBy=translation_group` and `locale={source_locale}` as query-param overrides to the underlying `fetchContentList` call (§6.5).

### 4.4 Delete-warning dialog

Existing trash and permanent-delete confirms in `ContentEditor` and the content list view get a pre-flight fetch:

1. On click of "Trash" or "Delete permanently", call `GET /content/{collection}/{id}/incoming-references` — show a `Loader` in the button.
2. If `totalCount === 0`: show the existing simple `ConfirmDialog`.
3. If `totalCount > 0`: show a wider `Dialog` (not `ConfirmDialog`, because the body needs structured content) with:
   - Heading varying by mode (`Trash this lesson?` vs `Permanently delete this lesson?`).
   - Lead sentence varying by mode (trash: "While in trash, this lesson is hidden from..."; permanent: "This will permanently remove this lesson from...").
   - A scrollable list of the groups, each rendered as `[fieldLabel] on [collection]` with up to 25 item titles linked to their editor pages, plus `+N more` if `more > 0`.
   - Confirm button is `variant="danger"` for permanent, `variant="primary"` for trash.

A small `ReferenceImpactList` component renders the body so the trash and permanent-delete dialogs share rendering.

### 4.5 Schema list view

In the existing field list (`SchemaEditor`), reference fields render with:
- The existing slug + label + type icon row.
- A subtitle: `→ Chapters · ⇆ chapter (One)` — target collection + reciprocal field slug + reciprocal cardinality.
- The reciprocal slug is a `RouterLinkButton variant="ghost"` linking to the target collection's schema editor with the field highlighted.

### 4.6 Localization & RTL

All strings introduced go through `useLingui` `t`. The pair-preview sentence uses `<Trans>` because of the embedded labels. The `→` and `⇆` glyphs are flipped via `rtl:-scale-x-100` on a `<span>` wrapper. Every margin/padding uses `ms-*`/`me-*`. The reciprocal `pluralize` only ever runs on ASCII slugs, never on the localized label.

## Section 5 — Migration and deprecation

### 5.1 Schema migration (forward-only)

A single new migration `NNN_reference_field_redesign.ts` does everything atomically:

1. **Add columns to `_emdash_fields`:**
   - `reciprocal_field_id TEXT` (NULL for non-reference fields)
   - `target_collection_id TEXT` with FK to `_emdash_collections(id)`
   - `CREATE INDEX idx_fields_reciprocal ON _emdash_fields(reciprocal_field_id)`
   - `CREATE INDEX idx_fields_target_collection ON _emdash_fields(target_collection_id)`

2. **Create `_emdash_references`** with the schema and indexes from §1 (lookup indexes + the static `UNIQUE(field_a_id, endpoint_a_group, endpoint_b_group)` dedupe).

3. **Convert existing reference fields to text:** for every `_emdash_fields` row with `type = 'reference'`, set `type = 'text'`. `column_type` was already `TEXT`, so no DDL on `ec_*` tables — the data column stays put with whatever raw strings users typed. `validation` JSON is preserved as-is.

4. **Forward-only `down`.** Per project rules, migrations are forward-only; the `down` handler reverses schema additions (drops the new columns and `_emdash_references`) but does not attempt to recreate `type = 'reference'` rows. Since the prior reference field was never functional, the rollback target isn't a meaningful state to restore to.

The migration touches **zero `ec_*` tables**. The column reuse strategy (TEXT → TEXT, just relabeling the field's `type`) means migrations on production sites are nearly instant regardless of content volume.

### 5.2 Static `reference()` helper — deprecation by error

The static helper at `packages/core/src/fields/reference.ts` throws at call time with a clear pointer to the new path. The new pair model fundamentally requires both fields to live in `_emdash_fields` (their ids are FKs of each other), so a static helper cannot produce a working pair on its own — silently degrading would re-create the original "looks like a field, isn't actually wired up" bug.

```ts
export function reference(
	_collection: string,
	_options?: { required?: boolean },
): never {
	throw new Error(
		"emdash: reference() is no longer functional. Reference fields are now bidirectional " +
			"relations and must be created through the admin schema editor, where both sides " +
			"of the pair can be tracked. If you need a raw text-pointer, use string() with a " +
			"validation pattern matching content IDs. See: <docs URL>"
	);
}
```

Why throw rather than soft-deprecate:
- The function never worked. Anyone with `reference()` in their `live.config.ts` already has a broken field.
- A `@deprecated` comment alone doesn't surface in dev — users would discover silent degradation in production.
- The error message hands the user a working alternative (`string()` with validation).

**Tests updated:** `packages/core/tests/fields/reference.test.ts` is rewritten to assert the throw and the message shape.

**Manifest path cleaned up:** the `if (schema.isReference)` branch in `packages/core/src/api/handlers/manifest.ts` is removed — it can never fire now. This trims dead code paths.

### 5.3 Type-cleanup pass

`FieldWidgetOptions` in `packages/core/src/schema/types.ts` drops `collection` and `allowMultiple`. The new homes:

| Old | New |
|---|---|
| `options.collection` | `_emdash_fields.target_collection_id` (column) |
| `options.allowMultiple` | `_emdash_fields.validation.allowMultiple` (JSON) |
| (none) | `_emdash_fields.reciprocal_field_id` (column) |

`FieldValidation` gains `allowMultiple?: boolean`. The `Field` TypeScript interface gains `targetCollectionId?: string` and `reciprocalFieldId?: string`. These flow through `CreateFieldInput` / `UpdateFieldInput`, but the actual wiring goes through the new `createReferencePair` / `updateReferencePair` registry methods — which compute these atomically rather than letting clients set them directly.

### 5.4 Changeset

Single changeset entry tagged for `emdash` with `minor` bump (pre-1.0; breaks are allowed in minors with explicit call-out per project rules):

```markdown
---
"emdash": minor
---

Reimplements the reference field as a bidirectional relation. Reference fields are
now created in pairs through the schema editor, with reciprocal fields auto-created
on the target collection. The static `reference()` helper now throws — convert
static collections to DB-managed ones, or use `string()` with a validation pattern
for raw ID storage. Existing reference fields in DB-managed collections are converted
to text fields automatically; their stored values are preserved as raw strings.
```

## Section 6 — i18n behavior and edge cases

### 6.1 Locale resolution rules

Every reference is stored as `endpoint_*_group`. Resolution to a concrete row at read time follows a fixed precedence (matches the menus/taxonomies path established in `036_i18n_menus_and_taxonomies.ts`):

1. **Source's locale**, if a live row exists in the target group at that locale.
2. **Site default locale**, if a live row exists at that locale.
3. **Any live row** in the group, ordered by `locale ASC` for deterministic ties.
4. Else the link doesn't resolve and is filtered from the response. The join row stays in `_emdash_references` (it's a group-level fact) — it just doesn't surface in this read.

"Live" means `deleted_at IS NULL`. Site default locale is read from `_emdash_options` (existing key); falls back to `en` if unset.

### 6.2 Translation creation, source side

Creating an `fr` translation of an existing post:

- New `ec_posts` row with the same `translation_group`, `locale = 'fr'`.
- `_emdash_references` is **untouched** — references live on the group.
- The new translation immediately inherits every reference. Its editor shows the same picks, resolved per §6.1 against `fr`.
- Editor UI: locale badge appears on each card whenever resolution falls back to a non-`fr` locale.

### 6.3 Translation creation, target side

Creating an `fr` translation of an already-referenced target:

- New row in target `ec_*` table, same group, locale `fr`.
- No write to `_emdash_references`.
- Source items in `fr` locale now resolve to the `fr` row automatically; their cards stop showing the fallback badge on the next render.

### 6.4 Translation deletion

- **Trash one translation** (group still has live rows): that locale stops being eligible for §6.1 resolution. Other locales are still found. Join rows are intact; restore reverses it.
- **Permanent delete one translation** (group still has live rows): same as above, irrecoverable for that locale.
- **Permanent delete the last live row in a group**: triggers cleanup. Inside the same transaction as the row delete, `DELETE FROM _emdash_references WHERE endpoint_a_group = ? OR endpoint_b_group = ?`.

The "last live row" check counts rows in the group regardless of `deleted_at` (since trashed-but-not-purged rows can still be restored). Only when the entire group is being purged from the DB do we tear down join rows.

### 6.5 Picker behavior under i18n

`GET /content/{collection}` gains a `groupBy=translation_group` query param. When set, the server returns one row per group, picking the best-locale row per §6.1 (with the source's locale hinted via the existing `locale` param). Response shape is unchanged — caller just sees fewer rows.

`ContentPickerModal` passes `groupBy=translation_group` and `locale={source_locale}` whenever invoked from a reference field. Each picker row shows its title in the resolved locale; if `resolvedLocale !== source_locale`, a locale badge is appended.

### 6.6 Self-referential i18n

`parent`/`children` on the same Pages collection works without special-casing: both endpoints store groups, both resolve via §6.1, and the no-self-loop check compares `endpoint_a_group` to `endpoint_b_group` — which differ across distinct pages even when the field's collection is the same.

A page can't reference itself or any locale variant of itself, because translations share a group — they'd hit the no-self-loop check. This is acceptable: parent/children semantically describes distinct logical pages, not locale variants.

### 6.7 Write-time target validation

On any reference write, before inserting the join row, the server validates: `SELECT 1 FROM <target ec_*> WHERE translation_group = ? AND deleted_at IS NULL LIMIT 1`. If no live row is found, reject with `VALIDATION_ERROR / TARGET_NOT_FOUND`. This catches:

- The target group never existed (bad client payload).
- The target was trashed mid-write.
- The target was permanently deleted mid-write.

Trashed-but-not-purged targets aren't valid pick targets — the picker filters them out (§6.5) and the validator rejects them on write. Restoring brings them back as valid targets.

### 6.8 Default-locale gotcha

If a site flips its default locale (rare, via settings), resolution-step-2 in §6.1 starts behaving differently for groups that have no row in the source's locale. We accept this — the site is explicitly opting into a different fallback regime, and the UI's locale badges will show users which locale each link landed on.

## Section 7 — Testing and rollout

### 7.1 Test surface

**Migration** (`tests/database/migrations.test.ts` extended):
- Applies cleanly on a DB with no reference fields.
- Applies cleanly on a DB with existing `type='reference'` rows — verifies they're converted to `text` and the underlying TEXT column is untouched.
- Idempotency: re-running the migration is rejected by the migration runner.
- Down migration drops new tables/columns without errors and leaves `_emdash_fields` rows in their post-migration `text` state.

**Schema registry** (`tests/integration/reference-pair.test.ts`, new):
- `createReferencePair` happy path: two field rows, both with correct `reciprocal_field_id` pointing at each other, both with correct `target_collection_id`, no `ec_*` columns added.
- Self-relation: parent/children on Pages — distinct field IDs, distinct slugs, same `collection_id`, both `target_collection_id`s point at Pages.
- Slug collision rejection: reciprocal slug already exists on target.
- Self-relation slug-equality rejection: parent/parent on Pages.
- `deleteReferencePair`: both rows removed, all `_emdash_references` rows for both field IDs removed, deleting one half always deletes the mate.
- `updateReferencePair`: changing `allowMultiple` doesn't validate existing data; changing label is independent per side.
- Invariant violations are impossible through the registry API even though the FK is application-level.

Run all of the above through `describeEachDialect` so SQLite and Postgres parity is covered.

**Handlers** (`tests/integration/content-references.test.ts`, new):
- Read enrichment: GET returns the resolved-target shape from §3.1; trashed targets filtered out; locale fallback runs through §6.1 precedence.
- Write reconciliation: covers add, remove, reorder, replace; transaction rolls back if any step fails.
- Validation: cardinality on insert (`allowMultiple=false` rejects a second row); no-self-loop; target-group-not-found rejection.
- `incoming-references` endpoint: returns the `groups` shape, caps items per group at 25 with `more` counting overflow, `totalCount` accurate, returns empty array on no incoming.
- Trash → restore round-trip: trashing hides target from reads; restore brings it back; join rows untouched.
- Permanent delete: last-live-row-in-group purges join rows in the same transaction; with-surviving-locales doesn't.
- Concurrent-write race documented with a deliberately skipped test (`it.skip` plus a comment) — useful for future hardening but out of scope to fix.

**i18n** (`tests/integration/content-references-i18n.test.ts`, new):
- Source-locale resolution preferred when target has it.
- Default-locale fallback when source-locale missing.
- "Any live row" fallback when neither source nor default exists, deterministic by `locale ASC`.
- Translation creation on source side: new locale row inherits all references, no writes to `_emdash_references`.
- Translation creation on target side: existing source items in the new locale start resolving to it.
- Picker `groupBy=translation_group` query: returns one row per group, picks per §6.1.

**Admin UI** (vitest + jsdom, mirrors existing `packages/admin/tests/components/`):
- `FieldEditor.test.tsx`: pair-creation form populates reciprocal slug from labelSingular, validates reciprocal-slug collision, "preview sentence" reflects cardinality choices.
- `ReferenceField.test.tsx`: single mode renders empty/filled states correctly, multi mode supports add/remove/reorder, locale badge appears when resolved locale differs.
- `ContentPickerModal.test.tsx` extended: `lockedCollection` hides selector and skips collections fetch; `excludeGroups` filters client-side.
- `ReferenceImpactList.test.tsx`: renders grouped list with overflow indicator, no-incoming case omits the dialog body.

**E2E** (`tests/e2e/reference-field.spec.ts`, new): one happy-path script

1. Create Chapters and Lessons collections.
2. In Chapters' schema editor, add reference field "lessons" → Lessons, many↔one (reciprocal "chapter").
3. Verify reciprocal field appears on Lessons.
4. Create three Lessons, one Chapter, link them via the chapter's editor.
5. Open one Lesson, verify the back-link card resolves to the Chapter.
6. Trash the Chapter — confirm the impact dialog lists three Lessons; trash anyway.
7. Reopen a Lesson — back-link is gone (resolved to nothing).
8. Restore the Chapter from trash — back-link reappears.
9. Permanent-delete the Chapter — confirm dialog appears, confirm; back-links gone.
10. Verify `_emdash_references` is empty for that field pair (debug assertion).

### 7.2 Performance

**Read enrichment cost.** One query per reference field per item read, joining `_emdash_references` × target `ec_*`. For a content item with 1–3 reference fields the impact is 1–3 extra queries. Wrap the resolver in `requestCached` keyed by `(field_id, source_group, source_locale)` so multi-component reads dedupe within a single template render — same pattern as `getSiteSetting`.

**Query-count baseline.** Run `pnpm query-counts` after the implementation lands; review the snapshot diff in the PR. Expected to see 1–3 added queries per route that renders content with reference fields. Anything more needs investigation.

**No list-endpoint enrichment.** Confirmed in §3.2. The enrichment cost only hits detail views.

**Migration on large databases.** Touches one row per reference field in `_emdash_fields` (small) and creates an empty `_emdash_references`. No `ec_*` ALTER TABLEs. Should run in milliseconds even on large prod DBs.

### 7.3 Demo & template scan

Before merging, `grep -r "reference(" demos/ templates/ docs/` for static-helper usages. The user expects none (the function was never functional), but anything found is either:

- Removed from the demo/template entirely, or
- Replaced with a `string()` field per the deprecation message in §5.2.

The CLAUDE.md schema-registry section gets a one-paragraph note pointing future agents at `createReferencePair` for reference fields and noting that the type still exists but its semantics changed.

### 7.4 PR sequencing

Recommended split — each is reviewable on its own and the feature isn't user-visible until both ship:

1. **PR 1: storage + registry.** Migration, `_emdash_references` table, `createReferencePair` / `deleteReferencePair` / `updateReferencePair`, static-helper deprecation, schema-registry tests + dialect parity. No HTTP endpoints, no UI. Lands early so reviewers can trust the foundation.
2. **PR 2: server + UI.** New endpoints (read enrichment, write reconciliation, incoming-references, picker `groupBy`), `FieldEditor` pair flow, `ReferenceField` widget, `ContentPickerModal` extension, delete-warning dialog, `ReferenceImpactList`, e2e test. End-to-end working.

If the reviewer prefers a single PR, the test surface and file count are large but tractable (~25 files). Lean toward the split because PR 1 is mostly database/registry code with very different review needs from the UI work in PR 2.

### 7.5 Out of scope (deliberately deferred)

- Polymorphic references (one field, multiple target collections).
- Cross-author reference approvals (Voxel-style).
- Bulk-edit references on a list view.
- A standalone "Referenced by" sidebar — incoming references already surface as the reciprocal field on the target's editor; a separate panel would duplicate.
- Fixing the concurrent-write cardinality race (documented in §6.7 / §7.1).
- Changing target collection on an existing pair (forces delete-and-recreate per §4.1).

Each is a follow-up Discussion candidate, not part of this spec.
