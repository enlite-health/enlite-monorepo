/**
 * CreateLeadUseCase + publicLeadSchema unit tests (Task 1 — public intake).
 *
 * Covers:
 *  - patient lead: origin=web_form, status=SOLICITANTE, patient-owned contact
 *  - responsible lead: contact on a primary responsible, patient phone null
 *  - name placeholder when omitted
 *  - serviceType slug → Profession mapping
 *  - schema rejects invalid email + normalizes it
 */

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { CreateLeadUseCase, LEAD_PLACEHOLDER_FIRST_NAME } from '../CreateLeadUseCase';
import { publicLeadSchema } from '../../interfaces/validators/publicLeadSchema';
import type { PatientService } from '../PatientService';

type CreateNativeArgs = Parameters<PatientService['createNativePatient']>;

function makeService() {
  const createNativePatient = jest
    .fn<Promise<{ id: string; created: true }>, CreateNativeArgs>()
    .mockResolvedValue({ id: 'lead-001', created: true });
  const service = { createNativePatient } as unknown as PatientService;
  return { service, createNativePatient };
}

describe('CreateLeadUseCase', () => {
  it('patient lead: web_form/SOLICITANTE with patient-owned contact + mapped serviceType', async () => {
    const { service, createNativePatient } = makeService();
    const useCase = new CreateLeadUseCase(service);

    const result = await useCase.execute({
      serviceType: 'cuidadores',
      requesterType: 'patient',
      email: 'lead@example.com',
      phone: '+5491133334444',
      name: 'Marina',
      country: 'AR',
    });

    expect(result).toEqual({ id: 'lead-001' });

    const [input, opts] = createNativePatient.mock.calls[0];
    expect(opts).toEqual({
      origin: 'web_form',
      status: 'SOLICITANTE',
      contactEmail: 'lead@example.com',
    });
    expect(input.firstName).toBe('Marina');
    expect(input.lastName).toBeNull();
    expect(input.phoneWhatsapp).toBe('+5491133334444');
    expect(input.serviceType).toEqual(['CAREGIVER']);
    expect(input.responsibles).toBeUndefined();
  });

  it('responsible lead: contact lives on a primary responsible; patient has no phone/email', async () => {
    const { service, createNativePatient } = makeService();
    const useCase = new CreateLeadUseCase(service);

    await useCase.execute({
      serviceType: 'psicologos',
      requesterType: 'responsible',
      email: 'family@example.com',
      phone: '+5491155556666',
      name: 'Jorge',
      country: 'AR',
    });

    const [input, opts] = createNativePatient.mock.calls[0];
    // patient identity unknown; contact NOT on the patient
    expect(input.firstName).toBe(LEAD_PLACEHOLDER_FIRST_NAME);
    expect(input.phoneWhatsapp).toBeNull();
    expect(opts.contactEmail).toBeUndefined();
    // contact on the primary responsible
    expect(input.responsibles).toHaveLength(1);
    expect(input.responsibles![0]).toMatchObject({
      firstName: 'Jorge',
      phone: '+5491155556666',
      email: 'family@example.com',
      isPrimary: true,
      displayOrder: 1,
      source: 'web_form',
    });
    expect(input.serviceType).toEqual(['PSYCHOLOGIST']);
  });

  it('falls back to placeholder firstName when name is omitted', async () => {
    const { service, createNativePatient } = makeService();
    const useCase = new CreateLeadUseCase(service);

    await useCase.execute({
      serviceType: 'acompanantes_terapeuticos',
      requesterType: 'patient',
      email: 'noname@example.com',
      phone: '+5491100000000',
      country: 'AR',
    });

    const [input] = createNativePatient.mock.calls[0];
    expect(input.firstName).toBe(LEAD_PLACEHOLDER_FIRST_NAME);
    expect(input.serviceType).toEqual(['AT']);
  });
});

describe('publicLeadSchema', () => {
  const base = {
    serviceType: 'cuidadores',
    requesterType: 'patient',
    email: 'Person@Example.com',
    phone: '+5491133334444',
  };

  it('rejects an invalid email', () => {
    const parsed = publicLeadSchema.safeParse({ ...base, email: 'not-an-email' });
    expect(parsed.success).toBe(false);
  });

  it('normalizes email to trimmed lowercase and accepts a valid body', () => {
    const parsed = publicLeadSchema.safeParse({ ...base, email: '  Person@Example.com  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe('person@example.com');
    }
  });

  it('rejects an unknown serviceType', () => {
    const parsed = publicLeadSchema.safeParse({ ...base, serviceType: 'enfermeros' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown requesterType', () => {
    const parsed = publicLeadSchema.safeParse({ ...base, requesterType: 'agency' });
    expect(parsed.success).toBe(false);
  });
});
