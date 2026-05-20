import { z } from 'zod';

/**
 * Response schema for GET /api/admin/vacancies/:id.
 *
 * Focused on the shape-sensitive fields: arrays (string[], object[]) and
 * JSON records that historically were mis-serialized by SQL helpers like
 * `array_to_string`, producing strings where the frontend expected arrays.
 *
 * Uses `.passthrough()` so additional columns from `jp.*` come through
 * without rejection — the goal is to assert critical shape, not freeze the
 * entire payload.
 */

const TimeSlotSchema = z.object({
  start: z.string(),
  end: z.string(),
});

const EncuadreSchema = z
  .object({
    id: z.string(),
    worker_name: z.string().nullable(),
    worker_phone: z.string().nullable(),
    interview_date: z.string().nullable(),
    resultado: z.string().nullable(),
    attended: z.boolean().nullable(),
    rejection_reason_category: z.string().nullable(),
    rejection_reason: z.string().nullable(),
  })
  .passthrough();

const PublicationSchema = z
  .object({
    channel: z.string().nullable(),
    published_at: z.string().nullable(),
    recruiter: z.string().nullable(),
  })
  .passthrough();

export const AdminVacancyDetailSchema = z
  .object({
    id: z.string(),
    service_type: z.array(z.string()).nullable(),
    required_professions: z.array(z.string()).nullable(),
    schedule: z.record(z.array(TimeSlotSchema)).nullable(),
    social_short_links: z.record(z.string()).nullable(),
    encuadres: z.array(EncuadreSchema).nullable(),
    publications: z.array(PublicationSchema).nullable(),
  })
  .passthrough();

export type AdminVacancyDetailResponse = z.infer<typeof AdminVacancyDetailSchema>;
