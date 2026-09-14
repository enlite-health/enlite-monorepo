jest.mock('../patientTransaction', () => ({
  inPatientTransaction: jest.fn((fn: (client: unknown) => unknown) => fn({})),
}));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

import {
  RegisterImageConsentUseCase,
  ImageConsentAlreadyActiveError,
  ImageConsentReferenceNotFoundError,
  RepresentativeRequiredError,
} from '../RegisterImageConsentUseCase';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const INPUT = { consenterKind: 'PATIENT' as const, textVersion: 'v1', consentedAt: '2026-09-14T10:00:00Z' };

describe('RegisterImageConsentUseCase (D335 — registrar é opcional)', () => {
  it('feliz — devolve id', async () => {
    const repo = { register: jest.fn(async () => ({ id: 'c1' })) };
    const uc = new RegisterImageConsentUseCase(repo as never);
    await expect(uc.execute(PID, INPUT, 'uid-1')).resolves.toEqual({ id: 'c1' });
  });

  it('23505 na uq_vigente vira ImageConsentAlreadyActiveError', async () => {
    const repo = { register: jest.fn(async () => { throw { code: '23505', constraint: 'uq_patient_image_consents_vigente' }; }) };
    const uc = new RegisterImageConsentUseCase(repo as never);
    await expect(uc.execute(PID, INPUT, 'uid-1')).rejects.toThrow(ImageConsentAlreadyActiveError);
  });

  it('23514 (check) vira RepresentativeRequiredError', async () => {
    const repo = { register: jest.fn(async () => { throw { code: '23514' }; }) };
    const uc = new RegisterImageConsentUseCase(repo as never);
    await expect(uc.execute(PID, INPUT, 'uid-1')).rejects.toThrow(RepresentativeRequiredError);
  });

  it('23503 (FK) vira ImageConsentReferenceNotFoundError', async () => {
    const repo = { register: jest.fn(async () => { throw { code: '23503' }; }) };
    const uc = new RegisterImageConsentUseCase(repo as never);
    await expect(uc.execute(PID, INPUT, 'uid-1')).rejects.toThrow(ImageConsentReferenceNotFoundError);
  });

  it('erro desconhecido propaga sem tradução', async () => {
    const repo = { register: jest.fn(async () => { throw new Error('boom'); }) };
    const uc = new RegisterImageConsentUseCase(repo as never);
    await expect(uc.execute(PID, INPUT, 'uid-1')).rejects.toThrow('boom');
  });

  it('constrói pelo DEFAULT do construtor', () => {
    // eslint-disable-next-line no-new
    new RegisterImageConsentUseCase();
  });
});
