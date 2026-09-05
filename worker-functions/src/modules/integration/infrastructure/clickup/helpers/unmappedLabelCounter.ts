/**
 * unmappedLabelCounter — how many values each ClickUp field DROPPED, per field.
 *
 * WHY THIS FILE EXISTS (task 1.5 da change `campos-admissao`):
 *
 * Task 1.3 made every catalog map WARN when it fails to map a label. A warning answers
 * "something was dropped"; it does not answer "how much". The operator question this
 * change has to answer — and criterion 9.4 depends on it — is literally:
 *
 *     "o campo X descartou N valores nesta rodada"
 *
 * That sentence is also the exact wording the `lex` used to define what an alarm on a
 * clinical field is ALLOWED to say (`parecer-lex-asindexable.md`, C1):
 *
 *     "O operador precisa saber 'o campo X descartou N valores nesta rodada', não QUAL
 *      segmento clínico. A fase sobrevive inteira com nome do campo + tipo + contagem."
 *
 * ── GRANULARITY IS A COMPLIANCE DECISION, NOT AN ERGONOMIC ONE ───────────────
 *
 * The counter is keyed by FIELD NAME ONLY. It is deliberately NOT keyed by label.
 *
 * A per-LABEL counter on a clinical field is C1 violated by another path: the key set
 * of such a map IS the list of clinical values seen, and dumping it (a summary line, a
 * debug endpoint, a heap snapshot, an error report) publishes exactly what C1 marks as
 * PARE — the resolved label of `Segmentos Clínicos`, `Sexo Asignado al Nacer (Uso
 * Clínico)`, `Dependencia` and `Servicio`. Aggregating by label would leak by
 * accumulation what the warning was rewritten to stop leaking one line at a time.
 *
 * The field name is schema metadata: it names the ClickUp column, never a patient value.
 * "WHICH option does not map" is answered from the CATALOG (`/field`), with zero
 * patients involved — that is C2 of the same parecer, and it is a better answer anyway,
 * because it fires before the sync instead of during it.
 *
 * ── WHY EMISSION IS THRESHOLDED, AND NOT ONE LINE PER DISCARD ────────────────
 *
 * Criterion 9.4 of this change is "alarme afogado em ruído é alarme ausente" — the same
 * criterion that made task 1.3 silence the in-range orderindex probe of
 * `scripts/inspect-clickup-fields.ts`. The 1.3 warning already emits once per discarded
 * value; a second unconditional line per discard would double a volume that is
 * proportional to the incident (F33's scenario is 266 patients re-syncing).
 *
 * So the count is emitted on the FIRST discard of a field — the "this field started
 * dropping" alarm, which is the one that has to reach a human — and then only when the
 * running total crosses a power of ten (10, 100, 1000, …), which is the shape that turns
 * "something is wrong" into "this is an outage". Between thresholds the count is still
 * exact and still available: `getUnmappedLabelCount()` / `getUnmappedLabelCounts()`.
 *
 * ── SCOPE OF "ESTA RODADA" ──────────────────────────────────────────────────
 *
 * The counters live in module state, so "the run" is the PROCESS: a batch import script
 * from start to finish; a Cloud Function instance across the webhook calls it serves.
 * `resetUnmappedLabelCounts()` is what draws a narrower boundary, and a caller that owns
 * a run boundary should use it. It is NOT called from any mapping path on purpose — a
 * counter that resets itself is a counter that always reads low.
 */

/** Emit when the running total for a field crosses one of these. */
const EMIT_AT = (n: number): boolean => n === 1 || isPowerOfTen(n);

function isPowerOfTen(n: number): boolean {
  if (n < 10) return false;
  let v = n;
  while (v % 10 === 0) v /= 10;
  return v === 1;
}

/** field name → how many values that field dropped in this process. */
const counts = new Map<string, number>();

/**
 * Records that `field` dropped one value it could not map, and returns the new running
 * total for that field.
 *
 * ⚠️ `field` MUST be the ClickUp FIELD NAME — never the label, the orderindex, the option
 * uuid or anything derived from a patient value. See the granularity note above: the key
 * set of this map is designed to be safe to print in full.
 *
 * Does not replace the caller's own alarm (task 1.3): it counts, and speaks only at the
 * thresholds described above.
 */
export function recordUnmappedLabel(field: string): number {
  const next = (counts.get(field) ?? 0) + 1;
  counts.set(field, next);

  if (EMIT_AT(next)) {
    // C1/lex: field name + count. No label, no orderindex, no uuid, no task id.
    console.warn('[unmappedLabelCounter] ClickUp field dropped unmapped values (running total for this run):', {
      field,
      droppedThisRun: next,
    });
  }

  return next;
}

/** Exact running total for one field. `0` = this field has not dropped anything yet. */
export function getUnmappedLabelCount(field: string): number {
  return counts.get(field) ?? 0;
}

/**
 * Exact running totals for every field that dropped at least one value, as a plain
 * object. Safe to log in full — the keys are ClickUp field names (schema metadata).
 *
 * An EMPTY object is ambiguous by construction and the caller must treat it as such: it
 * means "nothing was dropped" OR "nothing ever called the counter" (a dead instrument
 * reads exactly like a clean run — F19/D157). `formatUnmappedLabelCounts()` says so out
 * loud instead of printing a reassuring blank.
 */
export function getUnmappedLabelCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

/** Clears every counter. For a caller that owns a run boundary, and for tests. */
export function resetUnmappedLabelCounts(): void {
  counts.clear();
}

/**
 * One human-readable line with every field and its count, ordered by count desc.
 * The empty case is spelled out rather than rendered as an encouraging blank.
 */
export function formatUnmappedLabelCounts(): string {
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    return 'no field recorded a dropped value — either nothing was dropped, or nothing called the counter';
  }
  return entries.map(([field, n]) => `"${field}"=${n}`).join(' · ');
}

/**
 * Emits the run summary. Meant for a caller that owns a run boundary (a batch import, a
 * scheduled sync) to call once when it finishes. Nothing in `src/` owns such a boundary
 * today, so this is exported and unused there on purpose — wiring it into the batch
 * scripts is a separate change, and those scripts are out of the scope of task 1.5.
 */
export function logUnmappedLabelSummary(source: string): void {
  console.warn(`[unmappedLabelCounter] ${source} — unmapped labels per field:`, formatUnmappedLabelCounts());
}
