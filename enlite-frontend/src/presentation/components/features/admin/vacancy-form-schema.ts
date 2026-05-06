import { z } from 'zod';
import type { ScheduleValue } from './vacancyScheduleUtils';
import { parseScheduleString } from './vacancyScheduleUtils';

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

/**
 * Google Meet URL pattern (canonical, with scheme): https://meet.google.com/xxx-xxxx-xxx
 * Same regex used by VacancyMeetLinksCard for the detail page.
 */
export const MEET_LINK_REGEX = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * Loose regex used while typing — accepts the link with or without the `https://`
 * prefix and with optional `www.`, so users can paste raw `meet.google.com/...`.
 * Always normalize to the canonical form via {@link normalizeMeetLink} before
 * sending to the backend.
 */
export const MEET_LINK_REGEX_LOOSE = /^(?:https?:\/\/)?(?:www\.)?meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/**
 * Normalize a user-provided Meet URL to the canonical
 * `https://meet.google.com/xxx-xxxx-xxx` form. Returns the original (trimmed)
 * input untouched when it does not match the loose pattern.
 */
export function normalizeMeetLink(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/i);
  if (!match) return trimmed;
  return `https://meet.google.com/${match[1].toLowerCase()}`;
}

const meetLinkSlot = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? normalizeMeetLink(v) : v))
  .refine((v) => !v || MEET_LINK_REGEX.test(v), { message: 'invalidMeetLink' });

export const vacancyFormSchema = z
  .object({
    title: z.string().min(3),
    status: z.string().optional(),
    required_professions: z.array(z.string()).min(1),
    required_sex: z.string().optional(),
    age_range_min: z.number().min(18).optional(),
    age_range_max: z.number().optional(),
    required_experience: z.string().optional(),
    worker_attributes: z.string().optional(),
    providers_needed: z.number({ invalid_type_error: 'required' }).min(1),
    work_schedule: z.string().optional(),
    schedule: z
      .array(z.object({ days: z.array(z.string()).min(1), timeFrom: z.string().min(1), timeTo: z.string().min(1) }))
      .min(1),
    salary_text: z.string().optional(),
    payment_day: z.string().optional(),
    daily_obs: z.string().optional(),
    /** ISO date `YYYY-MM-DD` from `<input type="date">`. Optional — backend
     *  defaults to NOW() when null/empty. */
    published_at: z.string().optional(),
    /** ISO date `YYYY-MM-DD`. Optional — left blank by default. */
    closes_at: z.string().optional(),
    /** 3 fixed Meet link slots. At least one must be a valid Google Meet URL. */
    meet_links: z.tuple([meetLinkSlot, meetLinkSlot, meetLinkSlot]),
  })
  .refine(
    (d) => !(d.age_range_min !== undefined && d.age_range_max !== undefined && d.age_range_max < d.age_range_min),
    { message: 'ageRangeInvalid', path: ['age_range_max'] },
  )
  .refine(
    (d) => d.meet_links.some((l) => !!l && MEET_LINK_REGEX.test(l)),
    { message: 'meetLinkRequired', path: ['meet_links'] },
  );

export type VacancyFormData = z.infer<typeof vacancyFormSchema>;

// ---------------------------------------------------------------------------
// Option constants
// ---------------------------------------------------------------------------

export const STATUS_OPTIONS = [
  'SEARCHING',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
] as const;

/**
 * Profession options exposed in the create-vacancy form. Operations only
 * recruits ATs and Cuidadores via the form today (other professions like
 * NURSE / KINESIOLOGIST / PSYCHOLOGIST stay valid in DB for legacy ClickUp
 * imports but are not user-selectable here).
 */
export const PROFESSION_OPTIONS = ['AT', 'CAREGIVER'] as const;

export const SEX_OPTIONS = ['M', 'F', 'BOTH'] as const;

export const AGE_RANGE_OPTIONS = [
  { label: 'Bebê', min: 0, max: 2 },
  { label: 'Criança', min: 3, max: 11 },
  { label: 'Adolescente', min: 12, max: 17 },
  { label: 'Adulto Jovem', min: 18, max: 35 },
  { label: 'Adulto', min: 36, max: 64 },
  { label: 'Idoso', min: 65, max: 99 },
] as const;

export const DEVICE_OPTIONS = [
  'DOMICILIARIO', 'ESCOLAR', 'INSTITUCIONAL', 'COMUNITARIO',
  'AMBULATORIO', 'INTERNACION', 'RESIDENCIAL', 'TRASLADO',
] as const;

export const DEPENDENCY_OPTIONS = ['Leve', 'Moderado', 'Grave', 'Alto', 'Muy Grave'] as const;

export const WORK_SCHEDULE_OPTIONS = ['full-time', 'part-time', 'flexible'] as const;

export const PROVINCE_OPTIONS = [
  'Buenos Aires', 'CABA', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba',
  'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja',
  'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan',
  'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
  'Tierra del Fuego', 'Tucumán',
] as const;

// ---------------------------------------------------------------------------
// Schedule conversion: SchedulePicker ↔ Backend JSONB
// ---------------------------------------------------------------------------

export interface ScheduleSlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

const DAY_KEY_TO_NUM: Record<string, number> = {
  dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6,
};
const NUM_TO_DAY_KEY: Record<number, string> = {
  0: 'dom', 1: 'lun', 2: 'mar', 3: 'mie', 4: 'jue', 5: 'vie', 6: 'sab',
};

/** SchedulePicker value → backend JSONB array */
export function scheduleToJsonb(value: ScheduleValue): ScheduleSlot[] {
  const result: ScheduleSlot[] = [];
  for (const entry of value) {
    if (!entry.days.length || !entry.timeFrom || !entry.timeTo) continue;
    for (const day of entry.days) {
      result.push({ dayOfWeek: DAY_KEY_TO_NUM[day] ?? 1, startTime: entry.timeFrom, endTime: entry.timeTo });
    }
  }
  return result;
}

/** Backend JSONB array → SchedulePicker value */
export function jsonbToSchedule(slots: ScheduleSlot[] | null): ScheduleValue {
  if (!slots || slots.length === 0) return [{ days: [], timeFrom: '', timeTo: '' }];
  const groups = new Map<string, string[]>();
  for (const s of slots) {
    const key = `${s.startTime}|${s.endTime}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(NUM_TO_DAY_KEY[s.dayOfWeek] ?? 'lun');
  }
  return Array.from(groups.entries()).map(([key, days]) => {
    const [timeFrom, timeTo] = key.split('|');
    return { days, timeFrom, timeTo };
  });
}

const EMPTY_SCHEDULE: ScheduleValue = [{ days: [], timeFrom: '', timeTo: '' }];

/** Build ScheduleValue from vacancy object (prefers JSONB, falls back to legacy text) */
export function buildScheduleFromVacancy(vacancy: any): ScheduleValue {
  if (vacancy.schedule && Array.isArray(vacancy.schedule) && vacancy.schedule.length > 0) {
    return jsonbToSchedule(vacancy.schedule);
  }
  if (vacancy.schedule_days_hours) {
    return parseScheduleString(vacancy.schedule_days_hours) ?? EMPTY_SCHEDULE;
  }
  return EMPTY_SCHEDULE;
}

// ---------------------------------------------------------------------------
// Build API payload from form data
// ---------------------------------------------------------------------------

export function buildVacancyPayload(
  data: VacancyFormData,
  caseNumber: number | null,
  patientId: string | null = null,
  patientAddressId: string | null = null,
) {
  const jsonb = scheduleToJsonb(data.schedule);
  return {
    case_number: caseNumber,
    title: data.title,
    patient_id: patientId,
    patient_address_id: patientAddressId,
    required_professions: data.required_professions,
    required_sex: data.required_sex || null,
    age_range_min: data.age_range_min ?? null,
    age_range_max: data.age_range_max ?? null,
    required_experience: data.required_experience || null,
    worker_attributes: data.worker_attributes || null,
    schedule: jsonb.length > 0 ? jsonb : null,
    work_schedule: data.work_schedule || null,
    providers_needed: data.providers_needed,
    salary_text: data.salary_text || 'A convenir',
    payment_day: data.payment_day || null,
    daily_obs: data.daily_obs || null,
    status: data.status,
    // Backend coalesces null published_at to NOW(); empty string is treated as
    // null too. closes_at stays null when blank.
    published_at: data.published_at?.trim() ? data.published_at : null,
    closes_at: data.closes_at?.trim() ? data.closes_at : null,
  };
}

// ---------------------------------------------------------------------------
// Default form values
// ---------------------------------------------------------------------------

/**
 * Today as `YYYY-MM-DD` in the user's local timezone — what `<input type="date">`
 * expects. We deliberately avoid `toISOString()` because it would shift to UTC
 * and produce yesterday's date for users in negative-offset zones (AR is UTC-3).
 */
function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const DEFAULT_FORM_VALUES: VacancyFormData = {
  title: '',
  status: 'SEARCHING',
  required_professions: [],
  required_sex: '',
  age_range_min: undefined,
  age_range_max: undefined,
  required_experience: '',
  worker_attributes: '',
  providers_needed: 1,
  work_schedule: '',
  schedule: [{ days: [], timeFrom: '', timeTo: '' }],
  salary_text: '',
  payment_day: '',
  daily_obs: '',
  // Publish defaults to today (operations rule: auto-fill, but editable). Closes blank.
  published_at: todayIsoDate(),
  closes_at: '',
  meet_links: ['', '', ''],
};
