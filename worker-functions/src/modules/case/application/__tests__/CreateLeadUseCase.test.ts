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
      name: 'Marina Sosa Ledesma',
      country: 'AR',
      consent: true,
    });

    expect(result).toEqual({ id: 'lead-001' });

    const [input, opts] = createNativePatient.mock.calls[0];
    expect(opts).toEqual({
      origin: 'web_form',
      status: 'SOLICITANTE',
      contactEmail: 'lead@example.com',
    });
    // "Para mí": o nome completo é do PACIENTE, quebrado no primeiro espaço.
    expect(input.firstName).toBe('marina');
    expect(input.lastName).toBe('sosa ledesma');
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
      name: 'Jorge Alberto Pérez',
      country: 'AR',
      consent: true,
    });

    const [input, opts] = createNativePatient.mock.calls[0];
    // O paciente nasce SEM nome — null, não placeholder. Quem preencheu foi o
    // familiar; inventar nome de paciente a partir do nome dele seria dado falso.
    expect(input.firstName).toBeNull();
    expect(input.lastName).toBeNull();
    expect(input.phoneWhatsapp).toBeNull();
    expect(opts.contactEmail).toBeUndefined();
    // Nome, telefone e e-mail vão INTEIROS para o responsável primário.
    expect(input.responsibles).toHaveLength(1);
    expect(input.responsibles![0]).toMatchObject({
      firstName: 'jorge',
      lastName: 'alberto pérez',
      phone: '+5491155556666',
      email: 'family@example.com',
      isPrimary: true,
      displayOrder: 1,
      source: 'web_form',
    });
    expect(input.serviceType).toEqual(['PSYCHOLOGIST']);
  });

  it('sobrenome composto fica inteiro em lastName (nada se perde)', async () => {
    const { service, createNativePatient } = makeService();
    const useCase = new CreateLeadUseCase(service);

    await useCase.execute({
      serviceType: 'acompanantes_terapeuticos',
      requesterType: 'patient',
      email: 'unnome@example.com',
      phone: '+5491100000000',
      name: 'Flavia Solo',
      country: 'AR',
      consent: true,
    });

    const [input] = createNativePatient.mock.calls[0];
    expect(input.firstName).toBe('flavia');
    expect(input.lastName).toBe('solo');
    expect(input.serviceType).toEqual(['AT']);
  });

  it('nome de um termo só (chamada direta, sem o schema): sobrenome vira null', async () => {
    const { service, createNativePatient } = makeService();
    const useCase = new CreateLeadUseCase(service);

    // O schema público exige dois termos, então este corpo não chega aqui pela
    // rota. O use case é defensivo mesmo assim: '' não pode ir para a coluna
    // como string vazia disfarçada de sobrenome.
    await useCase.execute({
      serviceType: 'cuidadores',
      requesterType: 'patient',
      email: 'umtermo@example.com',
      phone: '+5491100000003',
      name: 'Cher',
      country: 'AR',
      consent: true,
    });

    const [input] = createNativePatient.mock.calls[0];
    expect(input.firstName).toBe('cher');
    expect(input.lastName).toBeNull();
  });

  it('responsável: nome e sobrenome vão separados para patient_responsibles', async () => {
    const { service, createNativePatient } = makeService();
    const useCase = new CreateLeadUseCase(service);

    await useCase.execute({
      serviceType: 'cuidadores',
      requesterType: 'responsible',
      email: 'fam@example.com',
      phone: '+5491100000001',
      name: 'Flavia Unica',
      country: 'AR',
      consent: true,
    });

    const [input] = createNativePatient.mock.calls[0];
    expect(input.responsibles![0]).toMatchObject({ firstName: 'flavia', lastName: 'unica' });
  });

  it('NENHUM lead novo nasce com o placeholder — ele é só herança das 13 fichas antigas', async () => {
    const { service, createNativePatient } = makeService();
    const useCase = new CreateLeadUseCase(service);

    for (const requesterType of ['patient', 'responsible'] as const) {
      await useCase.execute({
        serviceType: 'cuidadores',
        requesterType,
        email: 'x@example.com',
        phone: '+5491100000002',
        name: 'Alguém Aqui',
        country: 'AR',
        consent: true,
      });
    }

    for (const [input] of createNativePatient.mock.calls) {
      expect(input.firstName).not.toBe(LEAD_PLACEHOLDER_FIRST_NAME);
      expect(input.responsibles?.[0]?.firstName).not.toBe(LEAD_PLACEHOLDER_FIRST_NAME);
    }
  });
});

describe('publicLeadSchema', () => {
  const base = {
    serviceType: 'cuidadores',
    requesterType: 'patient',
    email: 'Person@Example.com',
    phone: '+5491133334444',
    country: 'AR',
    consent: true,
  };
  /** Corpo válido = base + nome. Os casos de recusa usam `base` cru de propósito. */
  const valido = { ...base, name: 'Persona Válida' };

  it('REJEITA corpo sem nome — o campo é obrigatório desde 02/09 (D249)', () => {
    const semNome = { ...base };
    expect(publicLeadSchema.safeParse(semNome).success).toBe(false);
  });

  it('rejeita nome só com espaço (o trim acontece antes do min)', () => {
    expect(publicLeadSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
  });

  it('REJEITA nome com um termo só — exige nome E sobrenome (D249)', () => {
    expect(publicLeadSchema.safeParse({ ...base, name: 'Flavia' }).success).toBe(false);
    expect(publicLeadSchema.safeParse({ ...base, name: '  Flavia  ' }).success).toBe(false);
    expect(publicLeadSchema.safeParse({ ...base, name: 'Flavia Villagra' }).success).toBe(true);
  });

  it('rejects an invalid email', () => {
    const parsed = publicLeadSchema.safeParse({ ...base, email: 'not-an-email' });
    expect(parsed.success).toBe(false);
  });

  it('normalizes email to trimmed lowercase and accepts a valid body', () => {
    const parsed = publicLeadSchema.safeParse({ ...valido, email: '  Person@Example.com  ' });
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

  // ── D108/F0: jurisdiction and consent are server-enforced on this public,
  //    unauthenticated endpoint — the client-side form is NOT the gate. ──────

  it('rejects a body WITHOUT country (no silent AR default)', () => {
    const { country: _country, ...withoutCountry } = base;
    const parsed = publicLeadSchema.safeParse(withoutCountry);
    expect(parsed.success).toBe(false);
  });

  it('accepts country BR and preserves it', () => {
    const parsed = publicLeadSchema.safeParse({ ...valido, country: 'BR' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.country).toBe('BR');
    }
  });

  it('rejects a country outside AR|BR', () => {
    const parsed = publicLeadSchema.safeParse({ ...base, country: 'US' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a body WITHOUT consent (direct POST bypassing the form)', () => {
    const { consent: _consent, ...withoutConsent } = base;
    const parsed = publicLeadSchema.safeParse(withoutConsent);
    expect(parsed.success).toBe(false);
  });

  it('rejects consent=false — a non-consenting lead must never be stored', () => {
    const parsed = publicLeadSchema.safeParse({ ...base, consent: false });
    expect(parsed.success).toBe(false);
  });
});
