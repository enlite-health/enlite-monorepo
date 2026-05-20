import { describe, it, expect } from '@jest/globals';
import { AdminVacancyDetailSchema } from '../AdminVacancyDetailSchema';

const validResponse = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  title: 'Caso 226-1',
  status: 'SEARCHING',
  service_type: ['AT', 'CAREGIVER'],
  required_professions: ['AT'],
  schedule: {
    lunes: [{ start: '09:00', end: '17:00' }],
  },
  social_short_links: { facebook: 'https://fb.me/x' },
  encuadres: [
    {
      id: 'e1',
      worker_name: 'Ana',
      worker_phone: '+5491100000000',
      interview_date: null,
      resultado: null,
      attended: null,
      rejection_reason_category: null,
      rejection_reason: null,
    },
  ],
  publications: [
    {
      channel: 'whatsapp',
      published_at: '2026-05-20T00:00:00Z',
      recruiter: 'María',
    },
  ],
  // extra fields from jp.* — must pass through
  case_number: 226,
  vacancy_number: 1,
  created_at: '2026-05-20T00:00:00Z',
};

describe('AdminVacancyDetailSchema', () => {
  it('accepts a valid response with arrays for service_type and required_professions', () => {
    const result = AdminVacancyDetailSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it('rejects service_type as string — regression test for c.map bug', () => {
    const broken = { ...validResponse, service_type: 'AT, CAREGIVER' };
    const result = AdminVacancyDetailSchema.safeParse(broken);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'service_type');
      expect(issue).toBeDefined();
    }
  });

  it('rejects required_professions as string', () => {
    const broken = { ...validResponse, required_professions: 'AT' };
    const result = AdminVacancyDetailSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it('accepts null for service_type and required_professions', () => {
    const result = AdminVacancyDetailSchema.safeParse({
      ...validResponse,
      service_type: null,
      required_professions: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts null for encuadres and publications (empty FILTER WHERE)', () => {
    const result = AdminVacancyDetailSchema.safeParse({
      ...validResponse,
      encuadres: null,
      publications: null,
    });
    expect(result.success).toBe(true);
  });

  it('passes through unknown columns from jp.* without rejecting', () => {
    const result = AdminVacancyDetailSchema.safeParse({
      ...validResponse,
      some_future_column: 'unknown',
      another_one: 42,
    });
    expect(result.success).toBe(true);
  });
});
