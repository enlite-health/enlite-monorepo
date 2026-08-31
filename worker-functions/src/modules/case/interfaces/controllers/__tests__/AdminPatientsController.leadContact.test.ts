/**
 * AdminPatientsController — contrato do desempate do lead sem nome.
 *
 * O repositório já prova a máscara e o escopo (PatientQueryRepository.leadContact
 * .test.ts). O que só se prova AQUI, na fronteira HTTP, é o que efetivamente sai
 * no corpo da resposta e o que entra na trilha — que é justamente onde o defeito
 * seria invisível para o teste de unidade:
 *
 *   C1/C2  o payload carrega o campo mascarado, e null na ficha com nome real
 *   C5     a trilha registra uid/país/n/UUIDs — e NUNCA o e-mail, nem mascarado
 *
 * A trilha segue o molde da linha `patient_clinical.read` já existente neste
 * controller (lex 29/08 C3, molde OP-08): quem leu, de quem, quando — sem valor.
 */

const mockLoggerInfo = jest.fn();
jest.mock('@shared/logging', () => ({
  ...jest.requireActual('@shared/logging'),
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    warn: jest.fn(), error: jest.fn(),
    child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  },
}));

const mockList = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: jest.fn() }) }),
  },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn(), decrypt: jest.fn().mockResolvedValue(null),
  })),
}));
jest.mock('../../../infrastructure/PatientQueryRepository', () => ({
  PatientQueryRepository: jest.fn().mockImplementation(() => ({
    findDetailById: jest.fn(), list: mockList, stats: jest.fn(),
  })),
}));

import type { Request, Response } from 'express';
import { AdminPatientsController } from '../AdminPatientsController';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    clickupTaskId: null, firstName: 'Solicitante', lastName: null,
    diagnosis: null, dependencyLevel: null, clinicalSpecialty: null,
    serviceType: null, documentType: null, documentNumber: null, sex: null,
    status: 'SOLICITANTE', needsAttention: false, attentionReasons: [],
    addressesCount: 0, caseNumber: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    leadContactEmailMasked: 'joa•••@gmail.com',
    leadContactIsResponsible: false,
    ...overrides,
  };
}

function reqRes(query: Record<string, string> = {}, uid: string | null = 'staff-uid-1') {
  const req = { params: {}, query, body: {} } as unknown as Request;
  if (uid) (req as any).authContext = { principal: { id: uid } };
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [req, { json, status } as unknown as Response] as const;
}

const bodyOf = (res: Response) => (res as any).json.mock.calls[0][0];

beforeEach(() => { jest.clearAllMocks(); });

describe('C1/C2 — o que sai no corpo da resposta', () => {
  it('lead sem nome leva o e-mail MASCARADO no payload', async () => {
    mockList.mockResolvedValue({ rows: [baseRow()], total: 1 });
    const [req, res] = reqRes();

    await new AdminPatientsController().listPatients(req, res);

    expect(bodyOf(res).data[0].leadContactEmailMasked).toBe('joa•••@gmail.com');
  });

  it('ficha com nome real sai com null — nada de contato no payload', async () => {
    mockList.mockResolvedValue({
      rows: [baseRow({ firstName: 'Ana', lastName: 'García', leadContactEmailMasked: null })],
      total: 1,
    });
    const [req, res] = reqRes();

    await new AdminPatientsController().listPatients(req, res);

    expect(bodyOf(res).data[0].leadContactEmailMasked).toBeNull();
  });

  it('o corpo inteiro nunca contém um endereço de e-mail completo', async () => {
    mockList.mockResolvedValue({ rows: [baseRow()], total: 1 });
    const [req, res] = reqRes();

    await new AdminPatientsController().listPatients(req, res);

    // A máscara é do servidor: se alguém trocar por envio do cru, isto quebra.
    expect(JSON.stringify(bodyOf(res))).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('marca de responsável chega ao front (C6)', async () => {
    mockList.mockResolvedValue({
      rows: [baseRow({ leadContactIsResponsible: true })], total: 1,
    });
    const [req, res] = reqRes();

    await new AdminPatientsController().listPatients(req, res);

    expect(bodyOf(res).data[0].leadContactIsResponsible).toBe(true);
  });
});

describe('C5 — a trilha de leitura de contato', () => {
  function trilha() {
    return mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((a) => a && a.msg === 'patient_lead_contact.read');
  }

  it('registra uid, país, quantidade e os UUIDs dos pacientes expostos', async () => {
    mockList.mockResolvedValue({
      rows: [baseRow({ id: 'uuid-a' }), baseRow({ id: 'uuid-b' })], total: 2,
    });
    const [req, res] = reqRes({ country: 'AR' });

    await new AdminPatientsController().listPatients(req, res);

    expect(trilha()).toEqual({
      msg: 'patient_lead_contact.read',
      uid: 'staff-uid-1',
      country: 'AR',
      n: 2,
      patientIds: ['uuid-a', 'uuid-b'],
    });
  });

  it('⛔ o e-mail NUNCA entra na trilha — nem mascarado', async () => {
    mockList.mockResolvedValue({ rows: [baseRow()], total: 1 });
    const [req, res] = reqRes();

    await new AdminPatientsController().listPatients(req, res);

    const serializado = JSON.stringify(trilha());
    expect(serializado).not.toContain('@');
    expect(serializado).not.toContain('jo***');
  });

  it('request sem authContext ainda registra a leitura, com uid null', async () => {
    // O contato saiu; a trilha não pode sumir só porque o uid não foi resolvido
    // — sem linha, a leitura viraria ponto cego, que é o que a OP-08 fechou.
    mockList.mockResolvedValue({ rows: [baseRow()], total: 1 });
    const [req, res] = reqRes({}, null);

    await new AdminPatientsController().listPatients(req, res);

    expect(trilha().uid).toBeNull();
    expect(trilha().n).toBe(1);
  });

  it('sem contato exposto não há linha nenhuma (minimização)', async () => {
    mockList.mockResolvedValue({
      rows: [baseRow({ firstName: 'Ana', lastName: 'García', leadContactEmailMasked: null })],
      total: 1,
    });
    const [req, res] = reqRes();

    await new AdminPatientsController().listPatients(req, res);

    expect(trilha()).toBeUndefined();
  });

  it('conta só as linhas que realmente expuseram contato', async () => {
    mockList.mockResolvedValue({
      rows: [
        baseRow({ id: 'lead-1' }),
        baseRow({ id: 'real-1', firstName: 'Ana', lastName: 'García', leadContactEmailMasked: null }),
      ],
      total: 2,
    });
    const [req, res] = reqRes();

    await new AdminPatientsController().listPatients(req, res);

    expect(trilha().n).toBe(1);
    expect(trilha().patientIds).toEqual(['lead-1']);
  });
});
