import { sql, type Kysely } from "kysely";

import { columnExists } from "../dialect-helpers.js";

/**
 * Add `taxonomies.sort_order` and mint a position for every existing term.
 *
 * Groups are numbered by `(label, id)` — the order term listings used before
 * this migration — taking the label from the group's lowest row id, which is
 * the locale the term was first written in. That locale's rendered order is
 * unchanged the moment this runs; every other locale is re-sorted to match it,
 * because a position is shared by a whole translation_group and only one
 * locale's collation can win.
 *
 * A position belongs to a `translation_group`, not a row: every row of a group
 * carries the same value, and sibling groups are keyed on the raw `parent_id`
 * column, which holds the parent's translation_group. Numbering keys on
 * `parent_id`, so a group whose rows disagree about their parent is reconciled
 * first — otherwise it would be numbered into whichever sibling group one
 * arbitrary row happens to name.
 *
 * Only the `ALTER` is guarded; both passes below run unconditionally so a run
 * that dies partway can be retried. Guarding the whole migration strands a
 * partial numbering, because the retry early-returns on the column it added.
 */

/**
 * Translation groups per `UPDATE`. Each costs three bound parameters — a CASE
 * `WHEN`/`THEN` pair plus one slot in the `IN` list — which keeps a statement
 * inside D1's 100-parameter ceiling. Writing one group per statement instead
 * spends a subrequest per term, and a large taxonomy exhausts the 1,000 a
 * Worker gets on the free plan before the migration finishes.
 */
const GROUPS_PER_UPDATE = 32;

interface TermRow {
	id: string;
	name: string;
	label: string | null;
	parent_id: string | null;
	translation_group: string | null;
}

export async function up(db: Kysely<unknown>): Promise<void> {
	const fresh = !(await columnExists(db, "taxonomies", "sort_order"));
	if (fresh) {
		await db.schema
			.alterTable("taxonomies")
			.addColumn("sort_order", "integer", (col) => col.notNull().defaultTo(0))
			.execute();
	}

	const { rows } = await sql<TermRow>`
		SELECT id, name, label, parent_id, translation_group FROM taxonomies
	`.execute(db);

	await repairParents(db, rows);
	await mintPositions(db, rows, fresh);
}

/**
 * Give every row of a translation_group the same `parent_id`, mutating `rows` so
 * the numbering below sees the reconciled tree.
 *
 * `parent_id` holds the parent's translation_group, so it is locale-agnostic and
 * a group's rows should all agree. Reparenting used to write a single row, which
 * left a term nested in the locale it was moved in and a root everywhere else.
 * A non-null parent wins: it is the move somebody made, and the null is the row
 * that missed it.
 *
 * The winner is copied from a sibling row, so it already satisfies the self-FK
 * on `parent_id` and can't be rewritten into a dangling reference.
 */
async function repairParents(db: Kysely<unknown>, rows: TermRow[]): Promise<void> {
	const byGroup = new Map<string, TermRow[]>();
	for (const row of rows) {
		const group = row.translation_group ?? row.id;
		let members = byGroup.get(group);
		if (!members) byGroup.set(group, (members = []));
		members.push(row);
	}

	const winners = new Map<string, string>();
	for (const [group, members] of byGroup) {
		if (new Set(members.map((member) => member.parent_id)).size < 2) continue;

		const parented = members.filter((member) => member.parent_id !== null);
		// The anchor row decides when it names a parent, else the lowest row id
		// that does, so the choice is the same however the rows come back.
		const anchor = parented.find((member) => member.id === group);
		const decider = anchor ?? parented.toSorted((a, b) => a.id.localeCompare(b.id))[0];
		const winner = decider?.parent_id;
		if (winner === undefined || winner === null) continue;

		winners.set(group, winner);
		for (const member of members) member.parent_id = winner;
	}

	await applyByGroup(db, "parent_id", winners);
}

/**
 * Number each sibling group by `(label, id)`.
 *
 * When the column was just added every row already reads 0, so those positions
 * are left to the default. On a retry the column is already there and may hold
 * numbers from the run that failed, so every position is written explicitly.
 */
async function mintPositions(
	db: Kysely<unknown>,
	rows: readonly TermRow[],
	fresh: boolean,
): Promise<void> {
	// One entry per translation_group: a group holds a single position, and its
	// rows can disagree on label across locales, so the lowest row id decides for
	// the whole group. Taxonomy names are `[a-z][a-z0-9_]*` and parents are
	// ULIDs, so "/" can't appear in either half of the sibling key.
	const groups = new Map<string, { sibling: string; label: string; id: string }>();
	for (const row of rows) {
		const group = row.translation_group ?? row.id;
		const chosen = groups.get(group);
		if (chosen && chosen.id <= row.id) continue;
		groups.set(group, {
			sibling: row.name + "/" + (row.parent_id ?? ""),
			label: row.label ?? "",
			id: row.id,
		});
	}

	const siblings = new Map<string, { group: string; label: string; id: string }[]>();
	for (const [group, { sibling, label, id }] of groups) {
		let members = siblings.get(sibling);
		if (!members) siblings.set(sibling, (members = []));
		members.push({ group, label, id });
	}

	const positions = new Map<string, number>();
	for (const members of siblings.values()) {
		members.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
		for (const [position, member] of members.entries()) {
			if (position === 0 && fresh) continue;
			positions.set(member.group, position);
		}
	}

	await applyByGroup(db, "sort_order", positions);
}

/**
 * Set one column per translation_group, chunked to stay inside the parameter
 * ceiling.
 *
 * Keyed on `COALESCE(translation_group, id)` because this reads rows it didn't
 * write: the column is nullable, and a group of one whose value was never
 * backfilled is still a term that needs a position.
 */
async function applyByGroup(
	db: Kysely<unknown>,
	column: "parent_id" | "sort_order",
	values: ReadonlyMap<string, string | number>,
): Promise<void> {
	const entries = [...values];
	for (let index = 0; index < entries.length; index += GROUPS_PER_UPDATE) {
		const chunk = entries.slice(index, index + GROUPS_PER_UPDATE);
		const arms = sql.join(
			chunk.map(([group, value]) => sql`WHEN ${group} THEN ${value}`),
			sql` `,
		);
		const keys = sql.join(chunk.map(([group]) => sql`${group}`));
		await sql`
			UPDATE taxonomies
			SET ${sql.ref(column)} = CASE COALESCE(translation_group, id) ${arms} END
			WHERE COALESCE(translation_group, id) IN (${keys})
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (await columnExists(db, "taxonomies", "sort_order")) {
		await db.schema.alterTable("taxonomies").dropColumn("sort_order").execute();
	}
}
