/**
 * AddressAvailabilityCalculator
 *
 * Pure function — no DB access. Computes the availability window of a patient
 * address given the active vacancies pointing to it.
 *
 * "Active" statuses: SEARCHING | SEARCHING_REPLACEMENT | RAPID_RESPONSE | ACTIVE
 * Others (CLOSED, PENDING_ACTIVATION, SUSPENDED) do NOT consume capacity.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScheduleSlot {
  dayOfWeek: number; // 0 = Sun … 6 = Sat
  startTime: string; // "HH:MM"
  endTime: string;   // "HH:MM"
}

export interface ActiveVacancy {
  id: string;
  patient_address_id: string;
  status: string;
  schedule: ScheduleSlot[] | null | unknown;
}

export interface AvailabilityDayEntry {
  dayOfWeek: number;
  coveredHours: number;
  availableRanges: Array<{ start: string; end: string }>;
}

export interface AddressAvailability {
  totalCoveredHours: number;
  maxHours: 168;
  isFull: boolean;
  perDay: AvailabilityDayEntry[];
  activeVacanciesCount: number;
  hasUnknownSchedule: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set([
  'SEARCHING',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
  'ACTIVE',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parses "HH:MM" → total minutes since midnight. */
function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Formats total minutes since midnight → "HH:MM" (24-hour). */
function fromMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Computes the covered hours for a single schedule slot.
 * Handles midnight-crossing shifts: if endTime < startTime, the shift wraps
 * around (e.g. 20:00→08:00 = 12h). This prevents negative values.
 */
function slotHours(slot: ScheduleSlot): number {
  const start = toMinutes(slot.startTime);
  const end = toMinutes(slot.endTime);
  const minutes = end > start ? end - start : 1440 - start + end;
  return minutes / 60;
}

/**
 * Merges an array of [start, end] minute intervals into non-overlapping,
 * sorted intervals. Handles midnight-crossing by expanding to [start, 1440].
 * Only considers the portion within the day (0..1440 minutes).
 */
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];

  const normalized: Array<[number, number]> = [];
  for (const [s, e] of intervals) {
    if (e > s) {
      normalized.push([s, e]);
    } else {
      // Midnight-crossing: split into [s, 1440]
      normalized.push([s, 1440]);
      // The part after midnight [0, e] would be on the next day, treated separately
      // We do NOT add [0, e] here because per-day analysis is per calendar day
    }
  }

  normalized.sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const interval of normalized) {
    if (merged.length === 0) {
      merged.push([...interval]);
    } else {
      const last = merged[merged.length - 1]!;
      if (interval[0] <= last[1]) {
        last[1] = Math.max(last[1], interval[1]);
      } else {
        merged.push([...interval]);
      }
    }
  }

  return merged;
}

/**
 * Computes available (gap) ranges from merged covered intervals within [0, 1440].
 */
function computeGaps(covered: Array<[number, number]>): Array<{ start: string; end: string }> {
  const gaps: Array<{ start: string; end: string }> = [];
  let cursor = 0;

  for (const [s, e] of covered) {
    if (s > cursor) {
      gaps.push({ start: fromMinutes(cursor), end: fromMinutes(s) });
    }
    cursor = Math.max(cursor, e);
  }

  if (cursor < 1440) {
    gaps.push({ start: fromMinutes(cursor), end: '24:00' });
  }

  return gaps;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Computes address availability for a given addressId based on active vacancies.
 *
 * @param addressId - The ID of the patient address being evaluated
 * @param activeVacancies - All vacancies to consider (filtered here by addressId + status)
 */
export function computeAddressAvailability(
  addressId: string,
  activeVacancies: ActiveVacancy[],
): AddressAvailability {
  // Filter to only vacancies for this address AND with consuming status
  const relevant = activeVacancies.filter(
    (v) => v.patient_address_id === addressId && ACTIVE_STATUSES.has(v.status),
  );

  let hasUnknownSchedule = false;
  let totalCoveredHours = 0;

  // Collect per-day intervals: Map<dayOfWeek, Array<[startMin, endMin]>>
  const dayIntervals = new Map<number, Array<[number, number]>>();

  for (const vacancy of relevant) {
    const slots = Array.isArray(vacancy.schedule) ? (vacancy.schedule as ScheduleSlot[]) : [];

    if (slots.length === 0) {
      hasUnknownSchedule = true;
      continue;
    }

    for (const slot of slots) {
      const daySlots = dayIntervals.get(slot.dayOfWeek) ?? [];
      const start = toMinutes(slot.startTime);
      const end = toMinutes(slot.endTime);
      daySlots.push([start, end]);
      dayIntervals.set(slot.dayOfWeek, daySlots);
    }
  }

  // Build perDay: all 7 days
  const perDay: AvailabilityDayEntry[] = [];
  for (let day = 0; day < 7; day++) {
    const intervals = dayIntervals.get(day) ?? [];
    const merged = mergeIntervals(intervals);

    // Sum covered minutes (capped at 1440 per day)
    let coveredMinutes = 0;
    for (const [s, e] of merged) {
      coveredMinutes += e - s;
    }
    const coveredHours = coveredMinutes / 60;
    totalCoveredHours += coveredHours;

    const availableRanges = computeGaps(merged);

    perDay.push({ dayOfWeek: day, coveredHours, availableRanges });
  }

  // isFull: only true when all vacancies have schedules AND total >= 168h
  const isFull = !hasUnknownSchedule && totalCoveredHours >= 168;

  return {
    totalCoveredHours,
    maxHours: 168,
    isFull,
    perDay,
    activeVacanciesCount: relevant.length,
    hasUnknownSchedule,
  };
}
