jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));

import { GetVigenteImageConsentUseCase } from '../GetVigenteImageConsentUseCase';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('GetVigenteImageConsentUseCase', () => {
  it('sem consentimento vigente — null', async () => {
    const repo = { findVigente: jest.fn(async () => null) };
    const uc = new GetVigenteImageConsentUseCase(repo as never);
    await expect(uc.execute(PID)).resolves.toBeNull();
    expect(repo.findVigente).toHaveBeenCalledWith(PID);
  });

  it('com consentimento vigente — mapeia id/consenterKind/consentedAt', async () => {
    const repo = {
      findVigente: jest.fn(async () => ({
        id: CID,
        patient_id: PID,
        consenter_kind: 'REPRESENTATIVE',
        responsible_id: 'resp-1',
        document_id: null,
        text_version: 'v1',
        consented_at: '2026-09-14T10:00:00.000Z',
        revoked_at: null,
        revoked_by: null,
      })),
    };
    const uc = new GetVigenteImageConsentUseCase(repo as never);
    await expect(uc.execute(PID)).resolves.toEqual({
      id: CID,
      consenterKind: 'REPRESENTATIVE',
      consentedAt: '2026-09-14T10:00:00.000Z',
    });
  });

  it('constrói pelo DEFAULT do construtor (caminho de produção)', () => {
    // eslint-disable-next-line no-new
    new GetVigenteImageConsentUseCase();
  });
});
