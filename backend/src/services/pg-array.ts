/**
 * Helpers for building Postgres array predicates that work with Bun.SQL.
 *
 * Bun.SQL (Bun 1.3.3) CANNOT bind a JS array as a single parameter: passing
 * `["a", "c"]` for a `$n::text[]` placeholder serializes it as the bare text
 * `a,c` and Postgres rejects it with `malformed array literal: "a,c"`. This is
 * silent in tests that use a fake/mock SQL client, but every such query is
 * broken against a real Postgres server.
 *
 * The working pattern binds each element as its own scalar parameter and builds
 * an explicit array literal in SQL: `ANY(ARRAY[$1,$2,...]::text[])`. These
 * helpers append the scalar binds to an existing `params` array (mutating it)
 * and return the SQL fragment with correctly numbered placeholders.
 */

/**
 * Push each value of `values` onto `params` as a scalar parameter and return
 * the SQL fragment `ARRAY[$a,$b,...]::cast[]` referencing them.
 *
 * Placeholders are numbered relative to the current length of `params`, so the
 * fragment composes correctly with binds that were appended before it.
 *
 * For an empty `values`, returns `ARRAY[]::cast[]` (a valid empty array, no
 * binds added) so callers that forget to early-return still produce a
 * well-formed never-match predicate instead of malformed SQL.
 */
export function pushArrayLiteral(params: unknown[], values: readonly unknown[], cast = "text"): string {
	if (values.length === 0) {
		return `ARRAY[]::${cast}[]`;
	}
	const placeholders: string[] = [];
	for (const value of values) {
		params.push(value);
		placeholders.push(`$${params.length}`);
	}
	return `ARRAY[${placeholders.join(",")}]::${cast}[]`;
}

/**
 * Build a `column = ANY(ARRAY[...]::cast[])` predicate, pushing each value onto
 * `params` as a scalar bind. Use this in place of the broken
 * `column = ANY($n::cast[])` pattern.
 *
 * For an empty `values`, returns `FALSE` (a guaranteed never-match) without
 * touching `params`, matching the semantics callers expect when there is
 * nothing to match.
 */
export function buildAnyArrayPredicate(
	column: string,
	values: readonly unknown[],
	params: unknown[],
	cast = "text",
): string {
	if (values.length === 0) {
		return "FALSE";
	}
	return `${column} = ANY(${pushArrayLiteral(params, values, cast)})`;
}
