/**
 * SQL fragments that keep personal documents out of the data.
 *
 * Receita's free-text fields hold CPFs in many shapes: at the end or middle of
 * a name, punctuated or not, in addresses and in e-mail accounts. Anything
 * shaped like a CPF goes, even with invalid check digits, since it may be a
 * mistyped CPF. CNPJ fragments such as "51.039.736" have too few digits to match.
 */

/** 11 digits, optionally separated like a CPF, not glued to other digits. */
const CPF = String.raw`\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[-.\s/]?\d{2}`;

export const CPF_SQL_PATTERN = String.raw`(^|\D)${CPF}(\D|$)`;

/**
 * Also catches sloppy punctuation, such as "123,456,789-00" or "123.456.789 -00".
 * Only for names: addresses are full of number sequences this would mistake for a CPF.
 */
const LOOSE_SEPARATOR = String.raw`[.,\s/-]{0,2}`;
const NAME_CPF_SQL_PATTERN = String.raw`(^|\D)\d{3}${LOOSE_SEPARATOR}\d{3}${LOOSE_SEPARATOR}\d{3}${LOOSE_SEPARATOR}\d{2}(\D|$)`;

const REPLACEMENT = String.raw`\1\2`;

/** Removes CPFs from a text expression, tidying what is left around them. */
export function withoutCpf(expression: string, pattern = CPF_SQL_PATTERN): string {
  const once = (input: string) => `regexp_replace(${input}, '${pattern}', '${REPLACEMENT}', 'g')`;
  // Twice: a separator consumed by one match can hide an adjacent one.
  const removed = once(once(expression));
  const noEmptyParens = String.raw`regexp_replace(${removed}, '\(\s*\)', '', 'g')`;
  const singleSpaced = String.raw`regexp_replace(${noEmptyParens}, '\s+', ' ', 'g')`;
  const noSpaceBeforeComma = `regexp_replace(${singleSpaced}, ' ,', ',', 'g')`;
  return `CASE WHEN regexp_matches(${expression}, '${pattern}')
    THEN NULLIF(trim(${noSpaceBeforeComma}, ' -/.,;:'), '')
    ELSE ${expression} END`;
}

/** Removes CPFs from a name or similar field, tolerating sloppy punctuation. */
export function nameWithoutCpf(expression: string): string {
  return withoutCpf(expression, NAME_CPF_SQL_PATTERN);
}

/** An e-mail account holding a CPF cannot be salvaged: the whole value goes. */
export function emailWithoutCpf(expression: string): string {
  return `CASE WHEN regexp_matches(${expression}, '${CPF_SQL_PATTERN}') THEN NULL ELSE ${expression} END`;
}
