/**
 * AdminTherapeuticProjectsController — o Projeto Terapêutico versionado e os 3 catálogos
 * (spec 017, D299). Molde: `AdminPatientContractedServicesController.test.ts` — repos falsos, o
 * resto REAL (schemas zod, `cellsOfRequest`, `projectTherapeuticVersionForActor`).
 *
 * Além de cada rota e cada código de erro, este arquivo carrega duas provas que valem por si:
 *  · lex C6 — o 400 de corpo inválido devolve só NOMES de campo, e nenhum `reportError` do
 *             arquivo recebe `req.body` (o corpo É texto clínico);
 *  · lex C7 — escrever exige `patient_clinical:write` além da célula do projeto; sem ela é 403
 *             NOMEANDO a célula que falta, e o repo nem é chamado.
 */
jest.mock('@modules/identity', () => ({
  AuthMiddleware: { getAuthContext: jest.fn() },
}));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import { AuthMiddleware } from '@modules/identity';
import { reportError } from '@shared/logging';
import type { Response } from 'express';
import { AdminTherapeuticProjectsController } from '../AdminTherapeuticProjectsController';
import { ServiceNotOfPatientError, SourceVersionNotFoundError, PatientNotFoundForProjectError } from '../../../infrastructure/TherapeuticProjectRepository';
import { CatalogItemsUnknownError, CatalogLabelTakenError } from '../../../infrastructure/TherapeuticCatalogRepository';
import { DiagnosisUnknownError } from '../../../application/pathologySegments';
import { TerminologyUnavailableError } from '@modules/terminology/domain/UnavailableTerminology';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VERSION_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const SOURCE_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE_ID = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';
const ITEM_ID = 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee';
const OBJ_ID = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
const ACT_ID = '11111111-bbbb-cccc-dddd-eeeeeeeeeeee';
const PAT_ID = '22222222-bbbb-cccc-dddd-eeeeeeeeeeee';

const TEXTO_CLINICO = 'paciente con crisis de ansiedad em 08/2026';

/** O corpo válido do "Novo" — é ele que carrega o texto clínico que não pode vazar no log. */
const CORPO_NOVO = {
  mode: 'new',
  version: {
    contractedServiceId: SERVICE_ID,
    modality: 'IN_PERSON',
    diagnoses: [{ uri: 'http://id.who.int/icd/entity/1', code: '6A02', title: 'TEA' }],
    clinicalContext: TEXTO_CLINICO,
    generalObjective: 'mejorar autonomía',
    specificObjectiveIds: [OBJ_ID],
    activityIds: [ACT_ID],
    startDate: '2026-01-01',
    endDate: '2026-06-30',
  },
};

const VERSAO = {
  id: VERSION_ID,
  patientId: PATIENT_ID,
  major: 1,
  minor: 0,
  version: 'V.1.0',
  editedFromVersionId: null,
  contractedServiceId: SERVICE_ID,
  modality: 'IN_PERSON',
  contractedServiceCode: 'CAREGIVER',
  diagnoses: [{ uri: 'u', code: '6A02', title: 'TEA' }],
  clinicalContext: TEXTO_CLINICO,
  generalObjective: 'mejorar autonomía',
  specificObjectives: [{ id: OBJ_ID, label: 'Objetivo A' }],
  activities: [{ id: ACT_ID, label: 'Atividade A' }],
  pathologyTypes: [{ id: '06', label: 'Trastornos mentales, del comportamiento y del neurodesarrollo' }],
  startDate: '2026-01-01',
  endDate: '2026-06-30',
  annulledAt: null,
  annulledBy: null,
  annulReason: null,
  createdBy: 'uid-autor',
  createdByName: 'Ana Joulie',
  createdAt: '2026-09-08T10:00:00.000Z',
  country: 'AR',
};

const ITEM = { id: ITEM_ID, label: 'Vínculo terapéutico', sortOrder: 10, active: true, deactivatedAt: null, createdAt: 'x', updatedAt: 'x' };

function mockReq(overrides: Record<string, unknown> = {}) {
  return { params: {}, body: {}, query: {}, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}
/** O controller com os dois repos falsos (a fronteira; o SQL é provado no e2e). */
function ctrl(repo: Record<string, unknown> = {}, catalogs: Record<string, unknown> = {}) {
  return new AdminTherapeuticProjectsController(repo as never, catalogs as never);
}
const corpoDaResposta = (res: { json: jest.Mock }) => res.json.mock.calls[0][0];

describe('AdminTherapeuticProjectsController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  it('sem repos injetados, constrói os dois de produção — e nenhum toca o pool no construtor', () => {
    expect(() => new AdminTherapeuticProjectsController()).not.toThrow();
  });

  describe('list', () => {
    it('400 quando :id não é UUID — o repo nem é chamado', async () => {
      const repo = { listForPatient: jest.fn() };
      const res = mockRes();
      await ctrl(repo).list(mockReq({ params: { id: 'nao-uuid' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Invalid params' });
      expect(repo.listForPatient).not.toHaveBeenCalled();
    });

    it('200 com as versões projetadas; `cells=null` (engine não decidiu, D113) devolve o clínico', async () => {
      const repo = { listForPatient: jest.fn().mockResolvedValue([VERSAO]) };
      const res = mockRes();
      await ctrl(repo).list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(repo.listForPatient).toHaveBeenCalledWith(PATIENT_ID);
      const [v] = corpoDaResposta(res).data.versions;
      expect(v.clinicalContext).toBe(TEXTO_CLINICO);
      expect(v).not.toHaveProperty('createdBy');
    });

    it('200 sem `patient_clinical:read` → os três campos clínicos saem null + marcador (lex C7)', async () => {
      const repo = { listForPatient: jest.fn().mockResolvedValue([VERSAO]) };
      const res = mockRes();
      await ctrl(repo).list(mockReq({ params: { id: PATIENT_ID }, permissionCells: ['patient_therapeutic_project:read'] }), res);
      const [v] = corpoDaResposta(res).data.versions;
      expect(v).toMatchObject({ clinicalContext: null, generalObjective: null, diagnoses: null, redacted: { clinical: true } });
      expect(JSON.stringify(corpoDaResposta(res))).not.toContain(TEXTO_CLINICO);
    });

    it('500 quando o repo lança — e o log leva só source + patientId', async () => {
      const repo = { listForPatient: jest.fn().mockRejectedValue(new Error('boom')) };
      const res = mockRes();
      await ctrl(repo).list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'AdminTherapeuticProjectsController:list',
        patientId: PATIENT_ID,
      });
    });

    it('500 quando o repo rejeita com algo que NÃO é Error (String(err) no reportError)', async () => {
      const repo = { listForPatient: jest.fn().mockRejectedValue('rejeição crua') };
      const res = mockRes();
      await ctrl(repo).list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][0].message).toBe('rejeição crua');
    });
  });

  describe('get', () => {
    it('400 quando :vid não é UUID', async () => {
      const repo = { findById: jest.fn() };
      const res = mockRes();
      await ctrl(repo).get(mockReq({ params: { id: PATIENT_ID, vid: 'nao-uuid' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.findById).not.toHaveBeenCalled();
    });

    it('404 quando a versão não é deste paciente (ou não existe)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(null) };
      const res = mockRes();
      await ctrl(repo).get(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 com a versão projetada pelas células do ator', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(VERSAO) };
      const res = mockRes();
      await ctrl(repo).get(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID }, permissionCells: [] }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(repo.findById).toHaveBeenCalledWith(PATIENT_ID, VERSION_ID);
      expect(corpoDaResposta(res).data).toMatchObject({ version: 'V.1.0', redacted: { clinical: true } });
    });

    it('500 quando o repo lança', async () => {
      const repo = { findById: jest.fn().mockRejectedValue(new Error('boom')) };
      const res = mockRes();
      await ctrl(repo).get(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'AdminTherapeuticProjectsController:get',
        patientId: PATIENT_ID,
        versionId: VERSION_ID,
      });
    });

    it('500 quando a rejeição não é Error', async () => {
      const repo = { findById: jest.fn().mockRejectedValue('rejeição crua') };
      const res = mockRes();
      await ctrl(repo).get(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][0].message).toBe('rejeição crua');
    });
  });

  describe('create', () => {
    it('400 quando :id não é UUID', async () => {
      const repo = { createVersion: jest.fn() };
      const res = mockRes();
      await ctrl(repo).create(mockReq({ params: { id: 'nao-uuid' }, body: CORPO_NOVO }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.createVersion).not.toHaveBeenCalled();
    });

    it('400 de corpo inválido devolve só NOMES de campo — nunca o valor (lex C6)', async () => {
      const repo = { createVersion: jest.fn() };
      const res = mockRes();
      const corpoRuim = { mode: 'new', version: { ...CORPO_NOVO.version, endDate: '2025-01-01' } };
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: corpoRuim }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Invalid body', details: { fields: ['version'] } });
      expect(JSON.stringify(corpoDaResposta(res))).not.toContain(TEXTO_CLINICO);
      expect(repo.createVersion).not.toHaveBeenCalled();
    });

    it('403 sem `patient_clinical:write`: a célula que falta é NOMEADA e o repo nem é chamado (lex C7)', async () => {
      const repo = { createVersion: jest.fn() };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_therapeutic_project:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_clinical:write' } });
      expect(repo.createVersion).not.toHaveBeenCalled();
    });

    it('201 no `new`: manda mode/patientId/actorUid e devolve a versão projetada', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(repo.createVersion).toHaveBeenCalledWith({
        mode: 'new', patientId: PATIENT_ID, actorUid: 'uid-1', version: CORPO_NOVO.version,
      });
      expect(corpoDaResposta(res).data.version).toBe('V.1.0');
    });

    it('201 no `edit`: o `fromVersionId` do corpo chega ao repo', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const res = mockRes();
      const corpo = { mode: 'edit', fromVersionId: SOURCE_ID, version: CORPO_NOVO.version };
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: corpo }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(repo.createVersion).toHaveBeenCalledWith({
        mode: 'edit', patientId: PATIENT_ID, actorUid: 'uid-1', fromVersionId: SOURCE_ID, version: CORPO_NOVO.version,
      });
    });

    it('sem contexto de auth o ator é `unknown` — a escrita não cai por falta de carimbo', async () => {
      (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(undefined);
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO }), mockRes());
      expect(repo.createVersion.mock.calls[0][0].actorUid).toBe('unknown');
    });

    it('404 quando a origem do "Editar" sumiu ou foi anulada (SourceVersionNotFoundError)', async () => {
      const repo = { createVersion: jest.fn().mockRejectedValue(new SourceVersionNotFoundError()) };
      const res = mockRes();
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: { mode: 'edit', fromVersionId: SOURCE_ID, version: CORPO_NOVO.version } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(corpoDaResposta(res)).toMatchObject({ code: 'source_version_not_found' });
      expect(reportError).not.toHaveBeenCalled();
    });

    it('404 quando o paciente não existe ou é invisível sob a RLS (PatientNotFoundForProjectError) — nunca 500', async () => {
      const repo = { createVersion: jest.fn().mockRejectedValue(new PatientNotFoundForProjectError()) };
      const res = mockRes();
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(corpoDaResposta(res)).toMatchObject({ code: 'patient_not_found' });
      expect(reportError).not.toHaveBeenCalled();
    });

    it('422 quando o serviço contratado é de OUTRO paciente (ServiceNotOfPatientError)', async () => {
      const repo = { createVersion: jest.fn().mockRejectedValue(new ServiceNotOfPatientError()) };
      const res = mockRes();
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(corpoDaResposta(res)).toMatchObject({ code: 'service_not_of_patient' });
      expect(reportError).not.toHaveBeenCalled();
    });

    it('422 com o kind e os ids quando o catálogo não reconhece as opções (lex C19)', async () => {
      const repo = { createVersion: jest.fn().mockRejectedValue(new CatalogItemsUnknownError('activities', ['x-1', 'x-2'])) };
      const res = mockRes();
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(corpoDaResposta(res)).toMatchObject({ code: 'catalog_items_unknown', details: { kind: 'activities', ids: ['x-1', 'x-2'] } });
    });

    it('422 `ptp_diagnosis_unknown` quando um CID-11 não resolve — SEM a URI no corpo (T7: é dado clínico) e sem reportError', async () => {
      const repo = { createVersion: jest.fn().mockRejectedValue(new DiagnosisUnknownError()) };
      const res = mockRes();
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Unknown diagnosis', code: 'ptp_diagnosis_unknown' });
      for (const d of CORPO_NOVO.version.diagnoses) expect(JSON.stringify(corpoDaResposta(res))).not.toContain(d.uri);
      expect(reportError).not.toHaveBeenCalled();
    });

    it('503 `TERMINOLOGY_UNAVAILABLE` quando a porta de terminologia está fora — nunca 500 mudo, sem reportError', async () => {
      const repo = { createVersion: jest.fn().mockRejectedValue(new TerminologyUnavailableError('catálogo indisponível')) };
      const res = mockRes();
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO }), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(corpoDaResposta(res)).toMatchObject({ success: false, code: 'TERMINOLOGY_UNAVAILABLE' });
      expect(reportError).not.toHaveBeenCalled();
    });

    it('500 no erro genérico — o log leva `mode`, jamais o corpo (lex C6)', async () => {
      const repo = { createVersion: jest.fn().mockRejectedValue(new Error('deadlock')) };
      const res = mockRes();
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'AdminTherapeuticProjectsController:create',
        patientId: PATIENT_ID,
        mode: 'new',
      });
    });

    it('500 quando a rejeição não é Error', async () => {
      const repo = { createVersion: jest.fn().mockRejectedValue('rejeição crua') };
      const res = mockRes();
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][0].message).toBe('rejeição crua');
    });
  });

  describe('annul (lex C5)', () => {
    it('400 quando :vid não é UUID', async () => {
      const repo = { annul: jest.fn() };
      const res = mockRes();
      await ctrl(repo).annul(mockReq({ params: { id: PATIENT_ID, vid: 'nao-uuid' }, body: { reason: 'erro' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.annul).not.toHaveBeenCalled();
    });

    it('400 quando o motivo carrega dado de pessoa (a guarda do schema) — só o nome do campo volta', async () => {
      const repo = { annul: jest.fn() };
      const res = mockRes();
      await ctrl(repo).annul(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID }, body: { reason: 'ver ana@x.com' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Invalid body', details: { fields: ['reason'] } });
      expect(repo.annul).not.toHaveBeenCalled();
    });

    it('404 quando a versão não existe OU já está anulada (o repo devolve null)', async () => {
      const repo = { annul: jest.fn().mockResolvedValue(null) };
      const res = mockRes();
      await ctrl(repo).annul(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID }, body: { reason: 'carga errada' } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 com a versão anulada, projetada pelas células', async () => {
      const anulada = { ...VERSAO, annulledAt: '2026-09-08T12:00:00.000Z', annulReason: 'carga errada' };
      const repo = { annul: jest.fn().mockResolvedValue(anulada) };
      const res = mockRes();
      await ctrl(repo).annul(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID }, body: { reason: 'carga errada' }, permissionCells: [] }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(repo.annul).toHaveBeenCalledWith(PATIENT_ID, VERSION_ID, 'uid-1', 'carga errada');
      expect(corpoDaResposta(res).data).toMatchObject({ annulledAt: '2026-09-08T12:00:00.000Z', redacted: { clinical: true } });
    });

    it('500 quando o repo lança', async () => {
      const repo = { annul: jest.fn().mockRejectedValue(new Error('boom')) };
      const res = mockRes();
      await ctrl(repo).annul(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID }, body: { reason: 'motivo' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'AdminTherapeuticProjectsController:annul',
        patientId: PATIENT_ID,
        versionId: VERSION_ID,
      });
    });

    it('500 quando a rejeição não é Error', async () => {
      const repo = { annul: jest.fn().mockRejectedValue('rejeição crua') };
      const res = mockRes();
      await ctrl(repo).annul(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID }, body: { reason: 'motivo' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][0].message).toBe('rejeição crua');
    });
  });

  describe('listCatalog', () => {
    it('200 só com os ativos por padrão; o `kind` vem da ROTA e volta na resposta', async () => {
      const catalogs = { list: jest.fn().mockResolvedValue([ITEM]) };
      const res = mockRes();
      await ctrl({}, catalogs).listCatalog('activities', mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(catalogs.list).toHaveBeenCalledWith('activities', { includeInactive: false });
      expect(corpoDaResposta(res)).toEqual({ success: true, data: { kind: 'activities', items: [ITEM] } });
    });

    it('`?includeInactive=true` (a string exata) liga os inativos; qualquer outro valor não', async () => {
      const catalogs = { list: jest.fn().mockResolvedValue([]) };
      await ctrl({}, catalogs).listCatalog('specific-objectives', mockReq({ query: { includeInactive: 'true' } }), mockRes());
      expect(catalogs.list).toHaveBeenCalledWith('specific-objectives', { includeInactive: true });
      await ctrl({}, catalogs).listCatalog('specific-objectives', mockReq({ query: { includeInactive: '1' } }), mockRes());
      expect(catalogs.list).toHaveBeenLastCalledWith('specific-objectives', { includeInactive: false });
    });

    it('500 quando o repo lança — o log leva o kind', async () => {
      const catalogs = { list: jest.fn().mockRejectedValue(new Error('boom')) };
      const res = mockRes();
      await ctrl({}, catalogs).listCatalog('specific-objectives', mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'AdminTherapeuticProjectsController:listCatalog',
        kind: 'specific-objectives',
      });
    });

    it('500 quando a rejeição não é Error', async () => {
      const catalogs = { list: jest.fn().mockRejectedValue('rejeição crua') };
      const res = mockRes();
      await ctrl({}, catalogs).listCatalog('activities', mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][0].message).toBe('rejeição crua');
    });
  });

  describe('createCatalogItem', () => {
    it('400 quando o rótulo carrega dado de pessoa (lex C18) — só o nome do campo volta', async () => {
      const catalogs = { create: jest.fn() };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'contato 11 98765-4321' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Invalid body', details: { fields: ['label'] } });
      expect(catalogs.create).not.toHaveBeenCalled();
    });

    it('201 com o rótulo e o ator carimbado', async () => {
      const catalogs = { create: jest.fn().mockResolvedValue(ITEM) };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('specific-objectives', mockReq({ body: { label: 'Vínculo terapéutico', sortOrder: 30 } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(catalogs.create).toHaveBeenCalledWith('specific-objectives', { label: 'Vínculo terapéutico', sortOrder: 30, actorUid: 'uid-1' });
      expect(corpoDaResposta(res)).toEqual({ success: true, data: ITEM });
    });

    it('409 quando o rótulo já existe entre os ATIVOS', async () => {
      const catalogs = { create: jest.fn().mockRejectedValue(new CatalogLabelTakenError()) };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'Repetido' } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(corpoDaResposta(res)).toMatchObject({ code: 'catalog_label_taken' });
      expect(reportError).not.toHaveBeenCalled();
    });

    it('500 no erro genérico', async () => {
      const catalogs = { create: jest.fn().mockRejectedValue(new Error('boom')) };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'AdminTherapeuticProjectsController:createCatalogItem',
        kind: 'activities',
      });
    });

    it('500 quando a rejeição não é Error', async () => {
      const catalogs = { create: jest.fn().mockRejectedValue('rejeição crua') };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][0].message).toBe('rejeição crua');
    });
  });

  describe('updateCatalogItem', () => {
    it('400 quando :itemId não é UUID', async () => {
      const catalogs = { update: jest.fn() };
      const res = mockRes();
      await ctrl({}, catalogs).updateCatalogItem('activities', mockReq({ params: { itemId: 'nao-uuid' }, body: { active: false } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Invalid params' });
      expect(catalogs.update).not.toHaveBeenCalled();
    });

    it('400 no patch VAZIO (o `.refine` do schema) — PATCH sem nada não é sucesso', async () => {
      const catalogs = { update: jest.fn() };
      const res = mockRes();
      await ctrl({}, catalogs).updateCatalogItem('activities', mockReq({ params: { itemId: ITEM_ID }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res).error).toBe('Invalid body');
      expect(catalogs.update).not.toHaveBeenCalled();
    });

    it('404 quando o item não existe (o repo devolve null)', async () => {
      const catalogs = { update: jest.fn().mockResolvedValue(null) };
      const res = mockRes();
      await ctrl({}, catalogs).updateCatalogItem('activities', mockReq({ params: { itemId: ITEM_ID }, body: { active: false } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 repassando o patch parcial + o ator (a baixa é `active:false`, nunca DELETE)', async () => {
      const catalogs = { update: jest.fn().mockResolvedValue({ ...ITEM, active: false }) };
      const res = mockRes();
      const desativar = mockReq({ params: { itemId: ITEM_ID }, body: { active: false } });
      await ctrl({}, catalogs).updateCatalogItem('activities', desativar, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(catalogs.update).toHaveBeenCalledWith('activities', ITEM_ID, { active: false, actorUid: 'uid-1' });
      expect(corpoDaResposta(res).data).toMatchObject({ active: false });
    });

    it('409 quando o novo rótulo colide com um ativo', async () => {
      const catalogs = { update: jest.fn().mockRejectedValue(new CatalogLabelTakenError()) };
      const res = mockRes();
      await ctrl({}, catalogs).updateCatalogItem('activities', mockReq({ params: { itemId: ITEM_ID }, body: { label: 'Repetido' } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(reportError).not.toHaveBeenCalled();
    });

    it('500 no erro genérico — o log leva kind e itemId', async () => {
      const catalogs = { update: jest.fn().mockRejectedValue(new Error('boom')) };
      const res = mockRes();
      await ctrl({}, catalogs).updateCatalogItem('activities', mockReq({ params: { itemId: ITEM_ID }, body: { label: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'AdminTherapeuticProjectsController:updateCatalogItem',
        kind: 'activities',
        itemId: ITEM_ID,
      });
    });

    it('500 quando a rejeição não é Error', async () => {
      const catalogs = { update: jest.fn().mockRejectedValue('rejeição crua') };
      const res = mockRes();
      await ctrl({}, catalogs).updateCatalogItem('activities', mockReq({ params: { itemId: ITEM_ID }, body: { label: 'X' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][0].message).toBe('rejeição crua');
    });
  });

  /**
   * A prova POSITIVA da lex C6, e não a leitura do código: TODAS as rotas que recebem corpo são
   * exercitadas com um `req.body` que carrega texto clínico, e nenhuma chamada de `reportError`
   * pode conter esse texto (nem a chave `body`).
   */
  describe('lex C6 — `reportError` NUNCA recebe `req.body`', () => {
    it('nenhum contexto de log de nenhuma rota com corpo carrega o corpo', async () => {
      const boom = () => jest.fn().mockRejectedValue(new Error('boom'));
      const repo = { listForPatient: boom(), findById: boom(), createVersion: boom(), annul: boom() };
      const catalogs = { list: boom(), create: boom(), update: boom() };
      const c = ctrl(repo, catalogs);
      const corpoClinico = { ...CORPO_NOVO, reason: TEXTO_CLINICO, label: TEXTO_CLINICO };

      const req = (over: Record<string, unknown>) => mockReq({ body: corpoClinico, ...over });
      await c.list(req({ params: { id: PATIENT_ID } }), mockRes());
      await c.get(req({ params: { id: PATIENT_ID, vid: VERSION_ID } }), mockRes());
      await c.create(req({ params: { id: PATIENT_ID }, body: CORPO_NOVO }), mockRes());
      await c.annul(req({ params: { id: PATIENT_ID, vid: VERSION_ID }, body: { reason: 'carga errada' } }), mockRes());
      await c.listCatalog('activities', req({}), mockRes());
      await c.createCatalogItem('activities', req({ body: { label: 'Rótulo válido' } }), mockRes());
      await c.updateCatalogItem('activities', req({ params: { itemId: ITEM_ID }, body: { label: 'Rótulo válido' } }), mockRes());

      const contextos = (reportError as jest.Mock).mock.calls.map((c2) => c2[1]);
      expect(contextos).toHaveLength(7);
      for (const ctx of contextos) {
        expect(Object.keys(ctx)).not.toContain('body');
        expect(JSON.stringify(ctx)).not.toContain(TEXTO_CLINICO);
        expect(JSON.stringify(ctx)).not.toContain('mejorar autonomía');
        expect(JSON.stringify(ctx)).not.toContain('6A02');
      }
    });
  });
});
