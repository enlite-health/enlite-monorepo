/**
 * CreatePatientUseCase — unit tests (Fase 1 Task 2).
 *
 *  a. Maps the input and calls createNativePatient with origin='admin_manual',
 *     status='ADMISSION', and contactEmail via opts (NOT inside the native input).
 *  b. Passes only firstName through when the rest is omitted.
 *  c. Translates the contact-channel Error into PatientContactValidationError.
 *  d. Re-throws any other error unchanged.
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
      lastName: 'Pérez',
      phoneWhatsapp: '+5491100000000',
      documentType: 'DNI',
      documentNumber: '12345678',
      healthInsuranceName: 'OSDE',
      healthInsuranceMemberId: 'A-9',
      serviceType: ['CAREGIVER', 'NURSE'],
    });
  });

  it('b. passes firstName through and nulls the omitted fields', async () => {
    const createNativePatient = jest.fn().mockResolvedValue({ id: 'pat-002', created: true });
    const useCase = new CreatePatientUseCase(makeService(createNativePatient));

    await useCase.execute({ firstName: 'Ana' });

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

    await expect(useCase.execute({ firstName: 'Sin Contacto' })).rejects.toBeInstanceOf(
      PatientContactValidationError,
    );
  });

  it('d. re-throws any other error unchanged', async () => {
    const createNativePatient = jest.fn().mockRejectedValue(new Error('DB down'));
    const useCase = new CreatePatientUseCase(makeService(createNativePatient));

    await expect(useCase.execute({ firstName: 'Juan' })).rejects.toThrow('DB down');
  });
});
