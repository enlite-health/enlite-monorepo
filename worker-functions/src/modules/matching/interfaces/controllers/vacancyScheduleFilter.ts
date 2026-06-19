/**
 * vacancyScheduleFilter.ts
 *
 * Pure, side-effect-free builder for the JSONB schedule filter on job_postings.
 *
 * schedule column: JSONB, always an array of
 *   { "dayOfWeek": int, "startTime": "HH:MM", "endTime": "HH:MM" }
 * dayOfWeek: 0=Sunday … 6=Saturday.
 *
 * Filtering semantics:
 *   - days (non-empty) + time: vacancy passes if, for EVERY requested day,
 *     at least one slot on that day overlaps the [timeFrom, timeTo) interval.
 *     Overlap = slot.startTime < timeTo AND slot.endTime > timeFrom (lexicographic).
 *   - days (non-empty) + no time: vacancy passes if, for EVERY requested day,
 *     at least one slot exists on that day (any hour).
 *   - days empty + time: vacancy passes if at least one slot (any day) overlaps.
 *   - nothing: no SQL appended.
 *
 * Partial time (only one of timeFrom / timeTo): time constraint is silently
 * ignored (only the day filter applies, or nothing if days are also absent).
 * Reason: a half-open interval is ambiguous and the caller should send both.
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ScheduleFilterInput {
  days: number[];
  timeFrom?: string;
  timeTo?: string;
}

export interface ScheduleFilterResult {
  /** SQL snippet starting with " AND …" or empty string if nothing to filter. */
  sql: string;
  /** Positional params to append to the existing params array. */
  params: unknown[];
  /** Updated paramIndex (= startIndex + params.length). */
  nextParamIndex: number;
}

/**
 * Builds parametrized SQL for the schedule JSONB filter.
 *
 * @param input    Filter criteria (days, optional timeFrom / timeTo).
 * @param startIdx The 1-based $N index of the FIRST new param this function will emit.
 */
export function buildScheduleFilter(
  input: ScheduleFilterInput,
  startIdx: number,
): ScheduleFilterResult {
  const { days } = input;

  // Validate times — both must be valid HH:MM; ignore if only one is present.
  const tfValid = typeof input.timeFrom === 'string' && TIME_RE.test(input.timeFrom);
  const ttValid = typeof input.timeTo === 'string' && TIME_RE.test(input.timeTo);
  const useTime = tfValid && ttValid;
  const timeFrom = useTime ? (input.timeFrom as string) : null;
  const timeTo   = useTime ? (input.timeTo   as string) : null;

  const hasDays = days.length > 0;
  const hasTime = useTime;

  if (!hasDays && !hasTime) {
    return { sql: '', params: [], nextParamIndex: startIdx };
  }

  const params: unknown[] = [];
  let idx = startIdx;

  if (hasDays && !hasTime) {
    // For each requested day: EXISTS a slot on that day.
    // bool_and over unnest([days]) ensures ALL days are present.
    params.push(days);                // $idx = int[]
    const dayParam = `$${idx}`;
    idx++;

    const sql = ` AND (
  SELECT bool_and(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(jp.schedule) s
      WHERE (s->>'dayOfWeek')::int = d.day
    )
  )
  FROM unnest(${dayParam}::int[]) AS d(day)
)`;
    return { sql, params, nextParamIndex: idx };
  }

  if (hasDays && hasTime) {
    // For each requested day: EXISTS a slot on that day that overlaps the interval.
    params.push(days);      // $idx   = int[]
    params.push(timeFrom);  // $idx+1 = text (timeFrom)
    params.push(timeTo);    // $idx+2 = text (timeTo)
    const dayParam = `$${idx}`;
    const tfParam  = `$${idx + 1}`;
    const ttParam  = `$${idx + 2}`;
    idx += 3;

    const sql = ` AND (
  SELECT bool_and(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(jp.schedule) s
      WHERE (s->>'dayOfWeek')::int = d.day
        AND s->>'startTime' < ${ttParam}
        AND s->>'endTime'   > ${tfParam}
    )
  )
  FROM unnest(${dayParam}::int[]) AS d(day)
)`;
    return { sql, params, nextParamIndex: idx };
  }

  // !hasDays && hasTime
  // EXISTS any slot (any day) that overlaps the interval.
  params.push(timeFrom);  // $idx   = text (timeFrom)
  params.push(timeTo);    // $idx+1 = text (timeTo)
  const tfParam = `$${idx}`;
  const ttParam = `$${idx + 1}`;
  idx += 2;

  const sql = ` AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(jp.schedule) s
  WHERE s->>'startTime' < ${ttParam}
    AND s->>'endTime'   > ${tfParam}
)`;
  return { sql, params, nextParamIndex: idx };
}

// ── Input parsers (pure, no side effects) ─────────────────────────────────────

/**
 * Parses a CSV string of integers as day-of-week values (0–6).
 * Invalid values and duplicates are silently discarded.
 * Returns a deduplicated, sorted int[].
 */
export function parseDaysCsv(raw: unknown): number[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const seen = new Set<number>();
  for (const token of raw.split(',')) {
    const n = parseInt(token.trim(), 10);
    if (!isNaN(n) && n >= 0 && n <= 6) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Validates a "HH:MM" time string.  Returns the string if valid, else undefined.
 */
export function parseTimeHHMM(raw: unknown): string | undefined {
  if (typeof raw === 'string' && TIME_RE.test(raw)) return raw;
  return undefined;
}
