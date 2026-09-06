/**
 * asIndexable — the allow-list guard for ClickUp drop_down values.
 *
 * WHY THIS FILE EXISTS (C5 do parecer do `lex`, 23/08/2026):
 *
 * The previous implementation was `Number(value)` with a NaN guard:
 *
 *     if (value === null || value === undefined) return null;
 *     const n = Number(value);
 *     return Number.isNaN(n) ? null : n;
 *
 * `Number([])` is `0` — but so are `Number('')`, `Number('   ')` and `Number(false)`.
 * And `0` is a VALID orderindex: the first option of the catalog. So any of those
 * values FABRICATED the first option of a clinical field (for `Segmentos Clínicos`,
 * orderindex 0 = 'AT para Pacientes con Discapacidad Intelectual'). Measured, on the
 * real mapper: `medicoes/campos-admissao/fase1/medicao-asindexable.txt` (4 of 5 falsy
 * shapes fabricated).
 *
 * A guard for arrays alone does NOT close the class — the fabrication is not the
 * array's, it is of ANY value that coerces to 0. The close is an ALLOW-LIST:
 * `number` finite, or non-empty numeric string. Everything else → `null` + warning.
 *
 * THE ROOT, and it is why the guard lives here and not in the resolver:
 * `ClickUpFieldResolver.resolveDropdown` DOES have a guard for `''` — it never fires,
 * because the pre-coercion turned `''` into `0` before the call. The pre-coercion
 * destroys exactly the type information the resolver's guards depend on. Fixing this
 * inside the resolver would be fixing the symptom downstream of the destruction.
 *
 * LOG FORMAT — C1 do parecer, and it is a PARE if violated:
 * The raw value of a clinical field NEVER goes into a log. Permitted per event:
 * `{ field, valueType, isArray, length }`. Forbidden on the same line: the orderindex,
 * the option uuid, the resolved label, and any patient identifier (`task.id`).
 * Reason: the raw value is the clinical value in CODED form, and the dictionary that
 * decodes it is public to anyone holding the token — coding is not protecting
 * (Ley 25.326 arts. 7º inc. 3, 9º inc. 1, 10). The operator needs to know "field X
 * dropped N values this run", never WHICH clinical value.
 *
 * The actionable "which option does not map" diagnosis comes from the CATALOG
 * (`getDropdownOptions()` / `/field` crossed with the map keys) — zero patients
 * involved (C2 do parecer).
 */

/** Length of array/string values only — never the content. Permitted by C1. */
function safeLength(value: unknown): number | null {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.length;
  return null;
}

function rejectNonIndexable(fieldName: string, value: unknown): null {
  // C1: field name + SHAPE of the value. No orderindex, no uuid, no label, no task id.
  console.warn('[asIndexable] Non-indexable ClickUp drop_down value (dropped):', {
    field: fieldName,
    valueType: typeof value,
    isArray: Array.isArray(value),
    length: safeLength(value),
  });
  return null;
}

/**
 * Converts a ClickUp custom-field value to an orderindex suitable for
 * `ClickUpFieldResolver.resolveDropdown()`.
 *
 * Accepts (allow-list): a finite `number`, or a non-empty numeric string.
 * Everything else — `[]`, `['uuid']`, `''`, `'   '`, `false`, `{}`, `NaN`,
 * `Infinity` — returns `null` AND warns in the C1 format.
 *
 * `null`/`undefined` return `null` SILENTLY, on purpose: that is the legitimate
 * "nobody filled the field in ClickUp" case, and it is the ONLY empty shape the
 * API was measured emitting (1424 of 1690 tasks for `Segmentos Clínicos` —
 * `medicoes/campos-admissao/fase1/formas-de-vazio-clickup.txt`). Warning on it
 * would drown the real alarm in noise, which is criterion 9.4 of this change.
 */
export function asIndexable(fieldName: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    // NaN and ±Infinity are not orderindexes. NaN never was (the old guard caught it);
    // Infinity was let through and would silently miss every option.
    return Number.isFinite(value) ? value : rejectNonIndexable(fieldName, value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    // '' and '   ' both coerce to 0 — the fabrication door. Closed here.
    if (trimmed === '') return rejectNonIndexable(fieldName, value);
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : rejectNonIndexable(fieldName, value);
  }

  // boolean, object, array (including the F33 scenario: `['uuid-a','uuid-b']` when the
  // field turns into `labels`), function, symbol, bigint.
  return rejectNonIndexable(fieldName, value);
}
