/**
 * AdminPatientContactRowsController — escrita por LINHA (spec 018, PR-1, ADR-1).
 * Repos e `inPatientTransaction` mockados: a prova end-to-end (SQL real, RLS, celulas reais) é o
 * e2e `tests/e2e/patient-support-network-rows.e2e.test.ts` e
 * `tests/e2e/patient-coverage-emergency-contacts.e2e.test.ts`. Aqui cobrimos os ramos de
 * validação/erro/guarda que os e2e não forçariam sem sabotar a API (400 de forma, mapeamento de
 * outcome para status HTTP, o 403 do profissional direto lendo o kind ATUAL).
 */
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));
const mockInPatientTransaction = jest.fn((fn: (client: unknown) => unknown) => fn({ marker: 'client' }));
jest.mock('../../../application/patientTransaction', () => ({
  inPatientTransaction: (fn: (client: unknown) => unknown) => mockInPatientTransaction(fn),
}));

import { AdminPatientContactRowsController } from '../AdminPatientContactRowsController';
import { ResponsiblePrimaryAlreadySetError } from '../../../infrastructure/PatientResponsibleRepository';
import { CoverageEmergencyContactLimitReachedError } from '../../../infrastructure/PatientCoverageEmergencyContactRepository';
import { AuthMiddleware } from '@modules/identity';
import type { Response } from 'express';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RESPONSIBLE_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONTACT_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReq(overrides: Record<string, unknown> = {}) {
  return { params: {}, body: {}, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe('AdminPatientContactRowsController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInPatientTransaction.mockImplementation((fn: (client: unknown) => unknown) => fn({ marker: 'client' }));
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  const db = () => ({ query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) });

  describe('createResponsible', () => {
    it('400 quando :id não é UUID; o repositório não é chamado', async () => {
      const repo = { insertOne: jest.fn() };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.createResponsible(mockReq({ params: { id: 'not-a-uuid' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.insertOne).not.toHaveBeenCalled();
    });

    it('400 quando o corpo não tem firstName/lastName', async () => {
      const repo = { insertOne: jest.fn() };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.createResponsible(mockReq({ params: { id: PATIENT_ID }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.insertOne).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe', async () => {
      const repo = { insertOne: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, pool as never);
      const res = mockRes();
      await controller.createResponsible(mockReq({ params: { id: PATIENT_ID }, body: { firstName: 'A', lastName: 'B' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.insertOne).not.toHaveBeenCalled();
    });

    it('201 com {id}; source=admin_manual fixo pelo controller; uid do ator vai ao repositório; displayOrder NÃO é mandado (o repositório é quem calcula MAX+1)', async () => {
      const repo = { insertOne: jest.fn().mockResolvedValue({ id: RESPONSIBLE_ID }) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.createResponsible(mockReq({ params: { id: PATIENT_ID }, body: { firstName: 'Ana', lastName: 'Diaz' } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: RESPONSIBLE_ID } });
      expect(repo.insertOne).toHaveBeenCalledWith(
        PATIENT_ID,
        { firstName: 'Ana', lastName: 'Diaz', isPrimary: false, source: 'admin_manual' },
        'uid-1',
        { marker: 'client' },
      );
      // Achado do gate `revisao-pr`: `displayOrder` fixo em 0 empatava não-titulares e a ordem
      // da ficha virava indeterminada (heap) — o controller não decide mais essa coluna.
      const [, corpo] = (repo.insertOne as jest.Mock).mock.calls[0];
      expect(corpo).not.toHaveProperty('displayOrder');
    });

    it('409 quando o repositório recusa por titular já ativo', async () => {
      const repo = { insertOne: jest.fn().mockRejectedValue(new ResponsiblePrimaryAlreadySetError()) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.createResponsible(mockReq({ params: { id: PATIENT_ID }, body: { firstName: 'A', lastName: 'B', isPrimary: true } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'PRIMARY_ALREADY_SET' }));
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-nao-e-Error'],
    ])('500 em erro inesperado do repositório — quando a rejeição %s', async (_desc, rejeicao) => {
      const repo = { insertOne: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.createResponsible(mockReq({ params: { id: PATIENT_ID }, body: { firstName: 'A', lastName: 'B' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('updateResponsible', () => {
    it('400 quando :rid não é UUID', async () => {
      const repo = { updateOne: jest.fn() };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.updateResponsible(mockReq({ params: { id: PATIENT_ID, rid: 'x' }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 quando o corpo tem chave fora do whitelist', async () => {
      const repo = { updateOne: jest.fn() };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.updateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID }, body: { displayOrder: 9 } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.updateOne).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe', async () => {
      const repo = { updateOne: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, pool as never);
      const res = mockRes();
      await controller.updateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID }, body: { firstName: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.updateOne).not.toHaveBeenCalled();
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-nao-e-Error'],
    ])('500 em erro inesperado do repositório — quando a rejeição %s', async (_desc, rejeicao) => {
      const repo = { updateOne: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.updateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID }, body: { firstName: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('404 quando o repositório devolve null (linha inexistente ou de outro paciente)', async () => {
      const repo = { updateOne: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.updateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID }, body: { firstName: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 com {id} quando encontrado', async () => {
      const repo = { updateOne: jest.fn().mockResolvedValue({ id: RESPONSIBLE_ID }) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.updateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID }, body: { phone: '1' } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(repo.updateOne).toHaveBeenCalledWith(PATIENT_ID, RESPONSIBLE_ID, { phone: '1' }, { marker: 'client' });
    });

    it('409 quando promover a titular colide com o índice único', async () => {
      const repo = { updateOne: jest.fn().mockRejectedValue(new ResponsiblePrimaryAlreadySetError()) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.updateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID }, body: { isPrimary: true } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
    });
  });

  describe('deactivateResponsible', () => {
    it('400 quando :rid não é UUID', async () => {
      const repo = { deactivate: jest.fn() };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.deactivateResponsible(mockReq({ params: { id: PATIENT_ID, rid: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.deactivate).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe (nem chega a chamar o repositório)', async () => {
      const repo = { deactivate: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, pool as never);
      const res = mockRes();
      await controller.deactivateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.deactivate).not.toHaveBeenCalled();
    });

    it('404 quando outcome = not_found', async () => {
      const repo = { deactivate: jest.fn().mockResolvedValue({ outcome: 'not_found' }) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.deactivateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('409 quando outcome = already_inactive', async () => {
      const repo = { deactivate: jest.fn().mockResolvedValue({ outcome: 'already_inactive' }) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.deactivateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('200 { id, active:false } quando desativado; uid do ator vai ao repositório', async () => {
      const repo = { deactivate: jest.fn().mockResolvedValue({ outcome: 'deactivated', id: RESPONSIBLE_ID }) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.deactivateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: RESPONSIBLE_ID, active: false } });
      expect(repo.deactivate).toHaveBeenCalledWith(PATIENT_ID, RESPONSIBLE_ID, 'uid-1', { marker: 'client' });
    });

    it('lex C6 — sem contexto de auth, a escrita é RECUSADA (500), nunca grava sentinela "unknown" em deactivated_by', async () => {
      (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(undefined);
      const repo = { deactivate: jest.fn().mockResolvedValue({ outcome: 'deactivated', id: RESPONSIBLE_ID }) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.deactivateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID } }), res);
      expect(repo.deactivate).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-nao-e-Error'],
    ])('500 em erro inesperado — quando a rejeição %s', async (_desc, rejeicao) => {
      const repo = { deactivate: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientContactRowsController(repo as never, {} as never, db() as never);
      const res = mockRes();
      await controller.deactivateResponsible(mockReq({ params: { id: PATIENT_ID, rid: RESPONSIBLE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('createCoverageEmergencyContact', () => {
    it('400 corpo inválido (kind fora do enum)', async () => {
      const repo = { insertOne: jest.fn() };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      await controller.createCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'FAMILY', name: 'x', phone: '1' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.insertOne).not.toHaveBeenCalled();
    });

    it('403 nomeando patient_care_team:read quando kind=DIRECT_PROFESSIONAL e o ator não tem a célula; o repositório não é chamado (nem o SELECT de existência do paciente)', async () => {
      const repo = { insertOne: jest.fn() };
      const pool = { query: jest.fn() };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, pool as never);
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID }, body: { kind: 'DIRECT_PROFESSIONAL', name: 'Dra.', phone: '1' }, permissionCells: ['patient_coverage:write'] });
      await controller.createCoverageEmergencyContact(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ details: { field: 'kind', cell: 'patient_care_team:read' } }));
      expect(repo.insertOne).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('DIRECT_PROFESSIONAL passa com patient_care_team:read; 201', async () => {
      const repo = { insertOne: jest.fn().mockResolvedValue({ id: CONTACT_ID }) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID }, body: { kind: 'DIRECT_PROFESSIONAL', name: 'Dra.', phone: '1' }, permissionCells: ['patient_coverage:write', 'patient_care_team:read'] });
      await controller.createCoverageEmergencyContact(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(repo.insertOne).toHaveBeenCalledWith(PATIENT_ID, { kind: 'DIRECT_PROFESSIONAL', name: 'Dra.', phone: '1' }, 'uid-1', { marker: 'client' });
    });

    it('sem células decididas (cells null — engine não decidiu): DIRECT_PROFESSIONAL passa', async () => {
      const repo = { insertOne: jest.fn().mockResolvedValue({ id: CONTACT_ID }) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID }, body: { kind: 'DIRECT_PROFESSIONAL', name: 'Dra.', phone: '1' }, permissionCells: null });
      await controller.createCoverageEmergencyContact(req, res);
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    it('AMBULANCE não exige patient_care_team:read', async () => {
      const repo = { insertOne: jest.fn().mockResolvedValue({ id: CONTACT_ID }) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID }, body: { kind: 'AMBULANCE', name: 'A', phone: '1' }, permissionCells: ['patient_coverage:write'] });
      await controller.createCoverageEmergencyContact(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('BLOCKER do gate revisao-pr — 409 nomeando o código quando o repositório recusa por teto (CoverageEmergencyContactLimitReachedError)', async () => {
      const repo = { insertOne: jest.fn().mockRejectedValue(new CoverageEmergencyContactLimitReachedError()) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      await controller.createCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'AMBULANCE', name: 'A', phone: '1' } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'COVERAGE_EMERGENCY_CONTACTS_LIMIT_REACHED' }));
    });

    it('404 quando o paciente não existe', async () => {
      const repo = { insertOne: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, pool as never);
      const res = mockRes();
      await controller.createCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'AMBULANCE', name: 'A', phone: '1' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.insertOne).not.toHaveBeenCalled();
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-nao-e-Error'],
    ])('500 em erro inesperado do repositório — quando a rejeição %s', async (_desc, rejeicao) => {
      const repo = { insertOne: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      await controller.createCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID }, body: { kind: 'AMBULANCE', name: 'A', phone: '1' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('updateCoverageEmergencyContact', () => {
    it('lê o kind ATUAL da linha (via getKind) quando o corpo não traz `kind`, e recusa se já é DIRECT_PROFESSIONAL sem a célula da equipe', async () => {
      const repo = { getKind: jest.fn().mockResolvedValue('DIRECT_PROFESSIONAL'), updateOne: jest.fn() };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID }, body: { phone: '999' }, permissionCells: ['patient_coverage:write'] });
      await controller.updateCoverageEmergencyContact(req, res);
      expect(repo.getKind).toHaveBeenCalledWith(PATIENT_ID, CONTACT_ID);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(repo.updateOne).not.toHaveBeenCalled();
    });

    it('com a célula da equipe, edita normalmente mesmo sem mandar `kind`', async () => {
      const repo = { getKind: jest.fn().mockResolvedValue('DIRECT_PROFESSIONAL'), updateOne: jest.fn().mockResolvedValue({ id: CONTACT_ID }) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID }, body: { phone: '999' }, permissionCells: ['patient_coverage:write', 'patient_care_team:read'] });
      await controller.updateCoverageEmergencyContact(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('quando o corpo TRAZ `kind`, usa o do corpo e NÃO chama getKind (curto-circuito do `??`)', async () => {
      const repo = { getKind: jest.fn(), updateOne: jest.fn().mockResolvedValue({ id: CONTACT_ID }) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID }, body: { kind: 'AMBULANCE' }, permissionCells: ['patient_coverage:write'] });
      await controller.updateCoverageEmergencyContact(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(repo.getKind).not.toHaveBeenCalled();
    });

    it('404 quando updateOne devolve null', async () => {
      const repo = { getKind: jest.fn().mockResolvedValue('AMBULANCE'), updateOne: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      await controller.updateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID }, body: { name: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sem `kind` no corpo e getKind → null (linha sumiu entre a leitura e o PATCH): o `?? undefined` normaliza, segue para o repositório, que devolve 404', async () => {
      const repo = { getKind: jest.fn().mockResolvedValue(null), updateOne: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      await controller.updateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID }, body: { name: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('400 corpo inválido', async () => {
      const controller = new AdminPatientContactRowsController({} as never, {} as never, db() as never);
      const res = mockRes();
      await controller.updateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID }, body: { kind: 'FAMILY' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('404 quando o paciente não existe (nem chega a ler o kind atual)', async () => {
      const repo = { getKind: jest.fn(), updateOne: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, pool as never);
      const res = mockRes();
      await controller.updateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID }, body: { name: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.getKind).not.toHaveBeenCalled();
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-nao-e-Error'],
    ])('500 em erro inesperado do repositório — quando a rejeição %s', async (_desc, rejeicao) => {
      const repo = { getKind: jest.fn().mockResolvedValue('AMBULANCE'), updateOne: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      await controller.updateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID }, body: { name: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('deactivateCoverageEmergencyContact', () => {
    it('400 quando :cid não é UUID (nem chega a checar o paciente)', async () => {
      const controller = new AdminPatientContactRowsController({} as never, {} as never, db() as never);
      const res = mockRes();
      await controller.deactivateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('lê o kind atual e recusa DIRECT_PROFESSIONAL sem patient_care_team:read; o deactivate não é chamado', async () => {
      const repo = { getKind: jest.fn().mockResolvedValue('DIRECT_PROFESSIONAL'), deactivate: jest.fn() };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID }, permissionCells: ['patient_coverage:write'] });
      await controller.deactivateCoverageEmergencyContact(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(repo.deactivate).not.toHaveBeenCalled();
    });

    it('404 / 409 / 200 conforme o outcome do repositório', async () => {
      const casos = [
        ['not_found', 404],
        ['already_inactive', 409],
      ] as const;
      for (const [outcome, status] of casos) {
        const repo = { getKind: jest.fn().mockResolvedValue('AMBULANCE'), deactivate: jest.fn().mockResolvedValue({ outcome }) };
        const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
        const res = mockRes();
        await controller.deactivateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID } }), res);
        expect(res.status).toHaveBeenCalledWith(status);
      }
      // getKind → null (linha já não existe): não é DIRECT_PROFESSIONAL, segue para o repositório,
      // que devolve not_found — o `?? undefined` normaliza null antes do `refuse...` checar o kind.
      const repoNula = { getKind: jest.fn().mockResolvedValue(null), deactivate: jest.fn().mockResolvedValue({ outcome: 'not_found' }) };
      const controllerNula = new AdminPatientContactRowsController({} as never, repoNula as never, db() as never);
      const resNula = mockRes();
      await controllerNula.deactivateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID } }), resNula);
      expect(resNula.status).toHaveBeenCalledWith(404);

      const repoOk = { getKind: jest.fn().mockResolvedValue('AMBULANCE'), deactivate: jest.fn().mockResolvedValue({ outcome: 'deactivated', id: CONTACT_ID }) };
      const controllerOk = new AdminPatientContactRowsController({} as never, repoOk as never, db() as never);
      const resOk = mockRes();
      await controllerOk.deactivateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID } }), resOk);
      expect(resOk.status).toHaveBeenCalledWith(200);
      expect(resOk.json).toHaveBeenCalledWith({ success: true, data: { id: CONTACT_ID, active: false } });
    });

    it.each([
      ['é uma Error de verdade', new Error('boom')],
      ['NÃO é uma Error (rejeição crua)', 'boom-nao-e-Error'],
    ])('500 em erro inesperado — quando a rejeição %s', async (_desc, rejeicao) => {
      const repo = { getKind: jest.fn().mockResolvedValue('AMBULANCE'), deactivate: jest.fn().mockRejectedValue(rejeicao) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, db() as never);
      const res = mockRes();
      await controller.deactivateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('404 quando o paciente não existe', async () => {
      const repo = { getKind: jest.fn(), deactivate: jest.fn() };
      const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      const controller = new AdminPatientContactRowsController({} as never, repo as never, pool as never);
      const res = mockRes();
      await controller.deactivateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: CONTACT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(repo.getKind).not.toHaveBeenCalled();
    });
  });

  describe('parâmetros inválidos (400) nas rotas de cobertura', () => {
    it('createCoverageEmergencyContact: :id não é UUID', async () => {
      const controller = new AdminPatientContactRowsController({} as never, {} as never, db() as never);
      const res = mockRes();
      await controller.createCoverageEmergencyContact(mockReq({ params: { id: 'x' }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('updateCoverageEmergencyContact: :cid não é UUID', async () => {
      const controller = new AdminPatientContactRowsController({} as never, {} as never, db() as never);
      const res = mockRes();
      await controller.updateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: 'x' }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('deactivateCoverageEmergencyContact: :cid não é UUID', async () => {
      const controller = new AdminPatientContactRowsController({} as never, {} as never, db() as never);
      const res = mockRes();
      await controller.deactivateCoverageEmergencyContact(mockReq({ params: { id: PATIENT_ID, cid: 'x' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
