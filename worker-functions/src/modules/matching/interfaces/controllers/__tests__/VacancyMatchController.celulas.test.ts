/**
 * F2/C3 — `GET /api/admin/vacancies/:id/match-results` sob as células.
 * A prova é o espião no KMS com zero chamadas (ver projectWorkerFields).
 */

const mockQuery = jest.fn();
const mockKmsDecrypt = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockKmsDecrypt })),
}));

import { Request, Response } from 'express';
import { VacancyMatchController } from '../VacancyMatchController';
import { NOME_REDIGIDO, CELL_WORKER_CONTACT_READ } from '@modules/identity/permissions';

const TELEFONE = '+5491133445566';

function reqRes(cells: string[] | null): [Request, Response] {
  const req = { params: { id: 'jp-1' }, body: {}, query: {} } as unknown as Request;
  if (cells !== null) (req as Request & { permissionCells?: string[] }).permissionCells = cells;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

function prepararQueries() {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ total: '1', last_match_at: null }] })
    .mockResolvedValueOnce({
      rows: [{
        worker_id: 'w-1',
        match_score: '0.9',
        internal_notes: null,
        source: 'system',
        application_funnel_stage: 'INVITED',
        messaged_at: null,
        phone: TELEFONE,
        first_name_encrypted: 'encrypted:María',
        last_name_encrypted: 'encrypted:González',
        occupation: 'ENFERMERA',
        status: 'ACTIVE',
        documents_status: null,
        work_zone: 'CABA',
        distance_km: 3.2,
        active_cases_count: 0,
      }],
    });
}

function candidato(res: Response) {
  return (res.json as jest.Mock).mock.calls[0][0].data.candidates[0];
}

describe('match-results — a célula decide ANTES do KMS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKmsDecrypt.mockImplementation((v: string) =>
      typeof v === 'string' && v.startsWith('encrypted:')
        ? Promise.resolve(v.slice('encrypted:'.length))
        : Promise.reject(new Error('KMS decrypt failed')));
  });

  it('sem worker_contact:read: ZERO chamadas ao KMS, e nada vaza pela fronteira', async () => {
    prepararQueries();
    const [req, res] = reqRes(['match:read']);
    await new VacancyMatchController().getMatchResults(req, res);

    expect(mockKmsDecrypt).toHaveBeenCalledTimes(0);
    const corpo = JSON.stringify((res.json as jest.Mock).mock.calls[0][0]);
    for (const proibido of ['María', 'González', TELEFONE]) {
      expect(corpo).not.toContain(proibido);
    }
  });

  it('sem a célula, o candidato continua na lista com o operacional', async () => {
    prepararQueries();
    const [req, res] = reqRes([]);
    await new VacancyMatchController().getMatchResults(req, res);

    expect(candidato(res)).toMatchObject({
      workerId: 'w-1',
      workerName: NOME_REDIGIDO,
      workerPhone: null,
      occupation: 'ENFERMERA',
      workZone: 'CABA',
      distanceKm: 3.2,
    });
  });

  it('com a célula, nome e telefone saem como antes', async () => {
    prepararQueries();
    const [req, res] = reqRes(['match:read', CELL_WORKER_CONTACT_READ]);
    await new VacancyMatchController().getMatchResults(req, res);

    expect(candidato(res)).toMatchObject({ workerName: 'María González', workerPhone: TELEFONE });
    expect(mockKmsDecrypt).toHaveBeenCalledTimes(2);
  });

  it('engine que não decidiu (`null`) devolve o que a rota já devolvia — D113', async () => {
    prepararQueries();
    const [req, res] = reqRes(null);
    await new VacancyMatchController().getMatchResults(req, res);

    expect(candidato(res)).toMatchObject({ workerName: 'María González', workerPhone: TELEFONE });
  });

  it('KMS fora do ar com a célula: cai em "Nome não disponível", não na redação', async () => {
    prepararQueries();
    mockKmsDecrypt.mockRejectedValue(new Error('KMS fora do ar'));
    const [req, res] = reqRes(['match:read', CELL_WORKER_CONTACT_READ]);
    await new VacancyMatchController().getMatchResults(req, res);

    // Falha de infra e falta de permissão são coisas diferentes na tela.
    expect(candidato(res).workerName).toBe('Nome não disponível');
    expect(candidato(res).workerPhone).toBe(TELEFONE);
  });
});
