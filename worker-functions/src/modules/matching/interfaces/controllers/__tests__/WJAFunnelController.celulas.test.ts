/**
 * F2/C3 — `GET /api/admin/vacancies/:id/funnel` (Kanban) sob as células.
 *
 * A asserção central é o ESPIÃO no KMS com ZERO chamadas, não o objeto
 * devolvido: redigir depois de descriptografar é esconder da tela — o texto
 * claro já existiu em memória e já pôde cair num log ou num stack trace do KMS.
 *
 * Esta rota tem DOIS sítios de descriptografia (cards de WJA e cards de
 * tentativa bloqueada, que fazem um SELECT próprio). Um teste que cobrisse só o
 * primeiro passaria com o segundo vazando.
 */

const mockQuery = jest.fn();
const mockKmsDecrypt = jest.fn();
const mockListByVacancy = jest.fn();

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

jest.mock('../../../infrastructure/BlockedApplicationQueryRepository', () => ({
  BlockedApplicationQueryRepository: jest.fn().mockImplementation(() => ({
    listByVacancy: mockListByVacancy,
  })),
}));

const mockTrilha = jest.fn();
jest.mock('@shared/audit/contactAccessFromRequest', () => ({
  emitirTrilhaDeContato: (...a: unknown[]) => mockTrilha(...a),
}));

jest.mock('../../../infrastructure/BlockedApplicationRepository', () => ({
  BlockedApplicationRepository: jest.fn().mockImplementation(() => ({
    dismiss: jest.fn(),
    undismiss: jest.fn(),
  })),
}));

import { Request, Response } from 'express';
import { WJAFunnelController } from '../WJAFunnelController';
import { NOME_REDIGIDO, CELL_WORKER_CONTACT_READ, CELL_MATCH_READ } from '@modules/identity/permissions';
import {
  PRESTADOR_CANARIO,
  esperaSemContatoDePrestador,
  esperaKmsNaoRodou,
} from '../../../__tests__/guardaVazamentoPrestador';

// Vocabulário ÚNICO (C4): canário próprio por teste é como o defeito clínico
// reincidiu 3× — cada guarda procurava a palavra que o autor dela lembrou.
const TELEFONE = PRESTADOR_CANARIO.telefone;

function reqRes(cells: string[] | null): [Request, Response] {
  const req = { params: { id: 'jp-1' }, body: {}, query: {} } as unknown as Request;
  // `undefined` é o estado real de "o engine não decidiu": a família ainda está
  // fora de PERMISSION_ENFORCED_ROUTES e o middleware não anexa nada.
  if (cells !== null) (req as Request & { permissionCells?: string[] }).permissionCells = cells;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

function linha() {
  return {
    id: 'wja-1',
    worker_id: 'wid-aaaa-bbbb-cccc-12345678',
    first_name_encrypted: `encrypted:${PRESTADOR_CANARIO.primeiroNome}`,
    last_name_encrypted: `encrypted:${PRESTADOR_CANARIO.sobrenome}`,
    worker_phone: TELEFONE,
    occupation_raw: 'AT',
    interview_date: null, interview_time: null, meet_link: null,
    resultado: null, attended: null,
    rejection_reason_category: null, rejection_reason: null, redireccionamiento: null,
    match_score: null, acquisition_channel: null,
    funnel_stage: 'CONFIRMED', source: null, talentum_status: null, work_zone: null,
  };
}

/** Candidato do match (Fase 5/D432): INVITED/system, nunca mensageado → COMPATIBLE. */
function candidatoDoMatch() {
  return {
    id: 'wja-compat',
    worker_id: 'wid-compat-999',
    first_name_encrypted: `encrypted:${PRESTADOR_CANARIO.primeiroNome}`,
    last_name_encrypted: `encrypted:${PRESTADOR_CANARIO.sobrenome}`,
    worker_phone: TELEFONE,
    occupation_raw: 'AT',
    interview_date: null, interview_time: null, meet_link: null,
    resultado: null, attended: null,
    rejection_reason_category: null, rejection_reason: null, redireccionamiento: null,
    match_score: 0.8, acquisition_channel: null,
    funnel_stage: 'INVITED', source: 'system', messaged_at: null,
    talentum_status: null, work_zone: null,
  };
}

/** Convite real (messaged_at setado), na MESMA resposta — controle positivo. */
function convidadoReal() {
  return { ...linha(), id: 'wja-invited', funnel_stage: 'INVITED', source: 'system', messaged_at: '2026-07-09T10:00:00Z' };
}

/** O card bloqueado: `listByVacancy` + um SELECT próprio no controller. */
function bloqueado() {
  return {
    id: 'ba-1', workerId: 'wid-blocked-999', dismissedAt: null, dismissedReason: null,
    acquisitionChannel: null, contactNotesCount: 0,
    blockedReason: 'MISSING_FIELDS', missingFields: ['dni'], attemptCount: 1,
  };
}

function todosOsCards(res: Response): Record<string, unknown>[] {
  const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
  return Object.values(stages as Record<string, Record<string, unknown>[]>).flat();
}

describe('funnel (Kanban) — a célula decide ANTES do KMS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockKmsDecrypt.mockImplementation((v: string) =>
      typeof v === 'string' && v.startsWith('encrypted:')
        ? Promise.resolve(v.slice('encrypted:'.length))
        : Promise.reject(new Error('KMS decrypt failed')));
  });

  it('sem worker_contact:read: KMS com ZERO chamadas nos DOIS sítios da rota', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [linha()] })                        // cards de WJA
      .mockResolvedValueOnce({ rows: [{                                  // card bloqueado
        first_name_encrypted: `encrypted:${PRESTADOR_CANARIO.primeiroNome}`,
        last_name_encrypted: `encrypted:${PRESTADOR_CANARIO.sobrenome}`,
        phone: PRESTADOR_CANARIO.whatsapp,
      }] });
    mockListByVacancy.mockResolvedValue([bloqueado()]);

    const [req, res] = reqRes(['funnel:read']);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    // 4 campos cifrados na fixture (2 por sítio): sem isso, 0 chamadas ao KMS
    // seria sucesso vazio, e `esperaKmsNaoRodou` recusa a invocação.
    esperaKmsNaoRodou(mockKmsDecrypt, 4);

    // Fronteira, com o vocabulário compartilhado — e não com a lista de nomes
    // que eu lembrei de escrever.
    esperaSemContatoDePrestador((res.json as jest.Mock).mock.calls[0][0]);
  });

  it('sem a célula, o card do Kanban continua existindo — redigir não é apagar', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [linha()] });
    mockListByVacancy.mockResolvedValue([]);

    const [req, res] = reqRes([]);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    const cards = todosOsCards(res);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'wja-1',
      workerId: 'wid-aaaa-bbbb-cccc-12345678',
      workerName: NOME_REDIGIDO,
      workerPhone: null,
      occupation: 'AT',
    });
  });

  it('com worker_contact:read o nome e o telefone saem, como antes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [linha()] });
    mockListByVacancy.mockResolvedValue([]);

    const [req, res] = reqRes(['funnel:read', CELL_WORKER_CONTACT_READ]);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    expect(todosOsCards(res)[0]).toMatchObject({
      workerName: PRESTADOR_CANARIO.nomeCompleto,
      workerPhone: TELEFONE,
    });
  });

  it('engine que NÃO decidiu (`permissionCells` ausente) não muda nada — D113', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [linha()] });
    mockListByVacancy.mockResolvedValue([]);

    const [req, res] = reqRes(null);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    // O contrato do rollout: engine desligado devolve o que a rota já devolvia.
    expect(todosOsCards(res)[0]).toMatchObject({
      workerName: PRESTADOR_CANARIO.nomeCompleto,
      workerPhone: TELEFONE,
    });
    expect(mockKmsDecrypt).toHaveBeenCalledTimes(2);
  });

  it('C6 — sem a célula, a trilha de contato NÃO grava: nada foi revelado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [linha()] });
    mockListByVacancy.mockResolvedValue([]);

    const [req, res] = reqRes([]);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    // A trilha é chamada, mas com lista vazia — o filtro é explícito, e é o
    // emissor que decide não gravar. Registrar "tentou ver" viraria trilha de
    // comportamento, que é outro tratamento (M1-2 proíbe uso disciplinar).
    expect(mockTrilha).toHaveBeenCalledTimes(1);
    expect(mockTrilha.mock.calls[0][1]).toEqual([null]);
  });

  it('C6 — com a célula, a trilha recebe o worker cujo contato SAIU', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [linha()] });
    mockListByVacancy.mockResolvedValue([]);

    const [req, res] = reqRes(['funnel:read', CELL_WORKER_CONTACT_READ]);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    expect(mockTrilha.mock.calls[0][1]).toEqual(['wid-aaaa-bbbb-cccc-12345678']);
  });

  it('o pseudônimo `Worker #…` não sobrescreve a redação', async () => {
    // Sem nome cifrado: com a célula, o card cai no pseudônimo; sem a célula,
    // tem de cair na redação — e não no pseudônimo, que revelaria o id.
    mockQuery.mockResolvedValueOnce({
      rows: [linha()].map(r => ({ ...r, first_name_encrypted: null, last_name_encrypted: null })),
    });
    mockListByVacancy.mockResolvedValue([]);

    const [req, res] = reqRes([]);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    expect(todosOsCards(res)[0].workerName).toBe(NOME_REDIGIDO);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Fase 5 (D432/DX-5.7) — Compatíveis é redigido por `match:read`,
  // NÃO por `worker_contact:read` (célula diferente da dos outros cards).
  // ═══════════════════════════════════════════════════════════════════

  it('Compatíveis sem match:read: redigido e ZERO KMS para essa linha; Invitados na MESMA resposta abre o nome (controle positivo)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidatoDoMatch(), convidadoReal()] });
    mockListByVacancy.mockResolvedValue([]);

    const [req, res] = reqRes(['funnel:read', CELL_WORKER_CONTACT_READ]);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;

    expect(stages.COMPATIBLE).toHaveLength(1);
    const compat = stages.COMPATIBLE[0] as Record<string, unknown>;
    expect(compat.workerName).toBe(NOME_REDIGIDO);
    expect(compat.workerId).toBeNull();
    expect(compat.encuadreId).toBeNull();
    expect(compat.workerPhone).toBeNull();

    // Controle positivo: o Invitado, na MESMA resposta, abre o nome — ele só
    // precisa de worker_contact:read; a redação de Compatíveis é outra célula.
    expect(stages.INVITED).toHaveLength(1);
    const invitado = stages.INVITED[0] as Record<string, unknown>;
    expect(invitado.workerName).toBe(PRESTADOR_CANARIO.nomeCompleto);
    expect(invitado.workerId).toBe('wid-aaaa-bbbb-cccc-12345678');

    // Espião: só o Invitado chamou o KMS (first_name + last_name); Compatíveis
    // nunca entrou em projectWorkerFields — 0 chamadas para essa linha.
    expect(mockKmsDecrypt).toHaveBeenCalledTimes(2);
  });

  it('Compatíveis com match:read: nome e id saem abertos', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidatoDoMatch()] });
    mockListByVacancy.mockResolvedValue([]);

    const [req, res] = reqRes(['funnel:read', CELL_WORKER_CONTACT_READ, CELL_MATCH_READ]);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    const cards = todosOsCards(res);
    expect(cards[0]).toMatchObject({
      workerName: PRESTADOR_CANARIO.nomeCompleto,
      workerId: 'wid-compat-999',
    });
  });

  it('Compatíveis com engine que NÃO decidiu (cells=null) abre o nome — D113', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidatoDoMatch()] });
    mockListByVacancy.mockResolvedValue([]);

    const [req, res] = reqRes(null);
    await new WJAFunnelController().getEncuadreFunnel(req, res);

    expect(todosOsCards(res)[0]).toMatchObject({
      workerName: PRESTADOR_CANARIO.nomeCompleto,
      workerId: 'wid-compat-999',
    });
  });
});
