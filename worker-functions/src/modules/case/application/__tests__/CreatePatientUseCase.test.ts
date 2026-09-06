/**
 * CreatePatientUseCase — unit tests (Fase 1 Task 2).
 *
 *  a. Maps the input and calls createNativePatient with origin='admin_manual',
 *     status='ADMISSION', and contactEmail via opts (NOT inside the native input).
 *  b. Passes only firstName through when the rest is omitted.
 *  c. Translates the contact-channel Error into PatientContactValidationError.
 *  d. Re-throws any other error unchanged.
 *  e. country comes from the caller — no 'AR' edge default (abac-pais-fase1 5.1).
 */

import {
  CreatePatientUseCase,
  PatientContactValidationError,
} from '../CreatePatientUseCase';
import type { PatientService } from '../PatientService';

function makeService(createNativePatient: jest.Mock): PatientService {
  return { createNativePatient } as unknown as PatientService;
}

describe('CreatePatientUseCase', () => {
  it('a. maps input and calls createNativePatient with admin_manual/ADMISSION + email via opts', async () => {
    const createNativePatient = jest.fn().mockResolvedValue({ id: 'pat-001', created: true });
    const useCase = new CreatePatientUseCase(makeService(createNativePatient));

    const result = await useCase.execute({
      firstName: 'Juan',
      country: 'AR',
      lastName: 'Pérez',
      phoneWhatsapp: '+5491100000000',
      contactEmail: 'juan@example.com',
      documentType: 'DNI',
      documentNumber: '12345678',
      healthInsuranceName: 'OSDE',
      healthInsuranceMemberId: 'A-9',
      serviceType: ['CAREGIVER', 'NURSE'],
    });

    expect(result).toEqual({ id: 'pat-001' });
    expect(createNativePatient).toHaveBeenCalledTimes(1);

    const [nativeInput, opts] = createNativePatient.mock.calls[0];
    expect(opts).toEqual({
      origin: 'admin_manual',
      status: 'ADMISSION',
      contactEmail: 'juan@example.com',
    });
    // contactEmail is NOT inside the native input — it goes only via opts.
    expect(nativeInput).not.toHaveProperty('contactEmail');
    expect(nativeInput).toMatchObject({
      firstName: 'Juan',
      country: 'AR',
      lastName: 'Pérez',
      phoneWhatsapp: '+5491100000000',
      documentType: 'DNI',
      documentNumber: '12345678',
      healthInsuranceName: 'OSDE',
      healthInsuranceMemberId: 'A-9',
      serviceType: ['CAREGIVER', 'NURSE'],
    });
  });

  it('a2. US-B6 (spec 012): birthDate do modal vai para o paciente nativo; ausente → null', async () => {
    const createNativePatient = jest.fn().mockResolvedValue({ id: 'nat-b6', created: true });
    const useCase = new CreatePatientUseCase({ createNativePatient } as never);
    const d = new Date('2015-06-20T00:00:00Z');
    await useCase.execute({ firstName: 'Nina', birthDate: d, country: 'AR' });
    expect(createNativePatient.mock.calls[0][0]).toMatchObject({ firstName: 'Nina', birthDate: d });
    await useCase.execute({ firstName: 'Sem', country: 'AR' });
    expect(createNativePatient.mock.calls[1][0]).toMatchObject({ birthDate: null });
  });

  it('b. passes firstName through and nulls the omitted fields', async () => {
    const createNativePatient = jest.fn().mockResolvedValue({ id: 'pat-002', created: true });
    const useCase = new CreatePatientUseCase(makeService(createNativePatient));

    await useCase.execute({ firstName: 'Ana', country: 'AR' });

    const [nativeInput, opts] = createNativePatient.mock.calls[0];
    expect(nativeInput.firstName).toBe('Ana');
    expect(nativeInput.phoneWhatsapp).toBeNull();
    expect(nativeInput.serviceType).toBeNull();
    expect(opts.contactEmail).toBeUndefined();
  });

  it('c. translates the contact-channel Error into PatientContactValidationError', async () => {
    const createNativePatient = jest
      .fn()
      .mockRejectedValue(new Error('Validação de contato: paciente ou responsável...'));
    const useCase = new CreatePatientUseCase(makeService(createNativePatient));

    await expect(
      useCase.execute({ firstName: 'Sin Contacto', country: 'AR' }),
    ).rejects.toBeInstanceOf(PatientContactValidationError);
  });

  it('d. re-throws any other error unchanged', async () => {
    const createNativePatient = jest.fn().mockRejectedValue(new Error('DB down'));
    const useCase = new CreatePatientUseCase(makeService(createNativePatient));

    await expect(useCase.execute({ firstName: 'Juan', country: 'AR' })).rejects.toThrow('DB down');
  });

  // ── e. No 'AR' edge default (abac-pais-fase1 5.1) ──────────────────────────
  // This is the regression guard for the bug the task exists to kill: the use
  // case used to hardcode country:'AR', so a BR patient created from the admin
  // modal was persisted as AR — invisible in BR-filtered views and filed under
  // the wrong legal regime (Ley 25.326 vs LGPD).
  it("e. forwards country='BR' verbatim — never overrides it with the old 'AR' default", async () => {
    const createNativePatient = jest.fn().mockResolvedValue({ id: 'pat-003', created: true });
    const useCase = new CreatePatientUseCase(makeService(createNativePatient));

    await useCase.execute({ firstName: 'João', country: 'BR' });

    const [nativeInput] = createNativePatient.mock.calls[0];
    expect(nativeInput.country).toBe('BR');
  });

  it('e2. forwards country=AR when the caller explicitly chose AR', async () => {
    const createNativePatient = jest.fn().mockResolvedValue({ id: 'pat-004', created: true });
    const useCase = new CreatePatientUseCase(makeService(createNativePatient));

    await useCase.execute({ firstName: 'Ana', country: 'AR' });

    expect(createNativePatient.mock.calls[0][0].country).toBe('AR');
  });
});
