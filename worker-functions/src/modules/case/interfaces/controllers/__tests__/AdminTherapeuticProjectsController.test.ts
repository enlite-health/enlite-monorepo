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
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ pool: 'fake' }) }) },
}));
// Só para a prova de memoização/lazy do getter `coverageContacts` (sem tocar o pool de verdade):
// o resto do arquivo passa o 4º repo por injeção e nunca deixa este mock ser instanciado.
jest.mock('../../../infrastructure/PatientCoverageEmergencyContactRepository', () => ({
  PatientCoverageEmergencyContactRepository: jest.fn().mockImplementation(() => ({ getKind: jest.fn().mockResolvedValue(null) })),
}));

import { AuthMiddleware } from '@modules/identity';
import { reportError } from '@shared/logging';
import type { Response } from 'express';
import { AdminTherapeuticProjectsController } from '../AdminTherapeuticProjectsController';
import { ServiceNotOfPatientError, SourceVersionNotFoundError, PatientNotFoundForProjectError, WaiveContactForbiddenError } from '../../../infrastructure/TherapeuticProjectRepository';
import {
  CatalogItemsUnknownError,
  CatalogLabelTakenError,
  CatalogItemNeedsOwnerError,
  ActivityCategoriesOutsideObjectiveError,
  CatalogObjectiveInvalidError,
  CatalogServiceInvalidError,
} from '../../../infrastructure/TherapeuticCatalogRepository';
import { InvalidIcdCategoryCodeError } from '../../../domain/icdCategory';
import {
  CatalogLinkOwnerNotFoundError,
  IcdCategoryAlreadyLinkedError,
  IcdCategoryNotInObjectiveError,
} from '../../../domain/TherapeuticCatalogLinkErrors';
import { DiagnosisUnknownError } from '../../../application/pathologySegments';
import { therapeuticTrailAction } from '../../../application/therapeuticProjectAccess';
import { TerminologyUnavailableError } from '@modules/terminology/domain/UnavailableTerminology';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VERSION_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const SOURCE_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE_ID = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';
const SEGMENT_ID = '33333333-bbbb-cccc-dddd-eeeeeeeeeeee';
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
    segmentId: SEGMENT_ID,
    contactStatus: {},
  },
};

/** O corpo do `mode:'edit'`: a mesma forma SEM `segmentId` (030: MACRO, só muda com "Nuevo"; o `.strict()` o recusa). */
const { segmentId: _segmentIdDoNovo, ...VERSAO_DO_EDIT } = CORPO_NOVO.version;

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
  segment: { id: SEGMENT_ID, label: 'AT para Pacientes con TEA' },
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

/** Portas da 091 (obrigatórias no construtor): fakes inertes quando o teste não as usa. */
const PORTAS_091 = [{ execute: jest.fn() }, {}, { search: jest.fn() }] as const;
/** Monta o controller com as 7 posições antigas + as 3 portas da 091. */
function novoController(antigas: unknown[] = [], portas: readonly unknown[] = PORTAS_091) {
  const [repo, catalogs, contacts, coverage, statuses, reminders, exitReasons] = antigas;
  return new (AdminTherapeuticProjectsController as unknown as new (...a: unknown[]) => AdminTherapeuticProjectsController)(
    repo, catalogs, contacts, coverage, statuses, reminders, exitReasons, ...portas,
  );
}

function mockReq(overrides: Record<string, unknown> = {}) {
  return { params: {}, body: {}, query: {}, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}
/** Stub de `TherapeuticProjectContactsRepository`: por padrão, versão sem contato nenhum (lex C5/C6). */
function stubContacts(): Record<string, unknown> {
  return { resolve: jest.fn().mockResolvedValue({ contacts: [], containersServed: new Set(), contactRefs: [], careTeamIds: [] }) };
}
/** Stub de `PatientCoverageEmergencyContactRepository`: por padrão, nenhum `COVERAGE` é `DIRECT_PROFESSIONAL`. */
function stubCoverageContacts(kinds: Record<string, string> = {}): Record<string, unknown> {
  return { getKind: jest.fn(async (_patientId: string, id: string) => kinds[id] ?? null) };
}
/** Stub de `TherapeuticProjectContactStatusRepository` (spec 048): por padrão, nenhum campo com status. */
function stubStatuses(byVersion: Record<string, unknown[]> = {}): Record<string, unknown> {
  return { listByVersions: jest.fn(async (ids: string[]) => new Map(ids.filter((i) => byVersion[i]).map((i) => [i, byVersion[i]]))) };
}
/** O controller com os cinco repos falsos (a fronteira; o SQL é provado no e2e). */
function ctrl(
  repo: Record<string, unknown> = {},
  catalogs: Record<string, unknown> = {},
  contacts: Record<string, unknown> = stubContacts(),
  coverageContacts: Record<string, unknown> = stubCoverageContacts(),
  statuses: Record<string, unknown> = stubStatuses(),
  reminders: Record<string, unknown> = { remainingReminderDates: jest.fn().mockResolvedValue(null) },
) {
  return novoController([repo, catalogs, contacts, coverageContacts, statuses, reminders]);
}
const corpoDaResposta = (res: { json: jest.Mock }) => res.json.mock.calls[0][0];

describe('AdminTherapeuticProjectsController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  it('sem repos injetados, constrói os dois de produção — e nenhum toca o pool no construtor', () => {
    expect(() => novoController()).not.toThrow();
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

    it('200 leva `data.fieldClass` no topo — dono único é THERAPEUTIC_FIELD_CLASS (task 7.7)', async () => {
      const repo = { listForPatient: jest.fn().mockResolvedValue([VERSAO]) };
      const res = mockRes();
      await ctrl(repo).list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(corpoDaResposta(res).data.fieldClass).toEqual({
        macro: ['contractedServiceId', 'diagnoses', 'clinicalContext', 'generalObjective', 'specificObjectiveIds', 'activityIds', 'segmentId'],
        micro: ['startDate', 'endDate', 'modality', 'contactRefs', 'careTeamIds'],
      });
    });

    it('`fieldClass` não muda por versão nem por lista vazia — é fixo do domínio, não por paciente', async () => {
      const repo = { listForPatient: jest.fn().mockResolvedValue([]) };
      const res = mockRes();
      await ctrl(repo).list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(corpoDaResposta(res).data.versions).toEqual([]);
      expect(corpoDaResposta(res).data.fieldClass.macro).toContain('clinicalContext');
    });

    it('500 quando o repo rejeita com algo que NÃO é Error (String(err) no reportError)', async () => {
      const repo = { listForPatient: jest.fn().mockRejectedValue('rejeição crua') };
      const res = mockRes();
      await ctrl(repo).list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][0].message).toBe('rejeição crua');
    });

    it('200 devolve `contactRefs`/`careTeamIds` CRUS em CADA versão da lista (conserto 14/09)', async () => {
      const repo = { listForPatient: jest.fn().mockResolvedValue([VERSAO]) };
      const contacts = {
        resolve: jest.fn().mockResolvedValue({
          contacts: [{ kind: 'CARE_TEAM', id: 'prof-1', name: 'Dra. Souza', phone: null }],
          containersServed: new Set(['care_team']),
          contactRefs: [],
          careTeamIds: ['prof-1'],
        }),
      };
      const res = mockRes();
      await ctrl(repo, {}, contacts).list(mockReq({ params: { id: PATIENT_ID } }), res);
      const [v] = corpoDaResposta(res).data.versions;
      expect(v.contactRefs).toEqual([]);
      expect(v.careTeamIds).toEqual(['prof-1']);
      expect(v.contacts).toEqual([{ kind: 'CARE_TEAM', id: 'prof-1', name: 'Dra. Souza', phone: null }]);
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

    it('200 anexa `contacts` resolvidos e grava os containers servidos em `req` (lex C6/C9)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(VERSAO) };
      const contacts = {
        resolve: jest.fn().mockResolvedValue({
          contacts: [{ kind: 'RESPONSIBLE', id: PAT_ID, name: 'Ana', phone: '+54...' }],
          containersServed: new Set(['family']),
          contactRefs: [{ kind: 'RESPONSIBLE', id: PAT_ID }],
          careTeamIds: [],
        }),
      };
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID }, permissionCells: ['patient_family:read'] });
      await ctrl(repo, {}, contacts).get(req, res);
      expect(contacts.resolve).toHaveBeenCalledWith(VERSION_ID, ['patient_family:read']);
      expect(corpoDaResposta(res).data.contacts).toEqual([{ kind: 'RESPONSIBLE', id: PAT_ID, name: 'Ana', phone: '+54...' }]);
      expect((req as unknown as { therapeuticContactContainers: string[] }).therapeuticContactContainers).toEqual(['family']);
    });

    it('200 devolve `contactRefs`/`careTeamIds` CRUS ao lado de `contacts` (conserto 14/09 — editar a vigente precisa reconstruir a seleção)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(VERSAO) };
      const contacts = {
        resolve: jest.fn().mockResolvedValue({
          contacts: [{ kind: 'RESPONSIBLE', id: PAT_ID, redacted: true }],
          containersServed: new Set(),
          contactRefs: [{ kind: 'RESPONSIBLE', id: PAT_ID }],
          careTeamIds: ['prof-1'],
        }),
      };
      const res = mockRes();
      await ctrl(repo, {}, contacts).get(mockReq({ params: { id: PATIENT_ID, vid: VERSION_ID }, permissionCells: [] }), res);
      expect(corpoDaResposta(res).data.contactRefs).toEqual([{ kind: 'RESPONSIBLE', id: PAT_ID }]);
      expect(corpoDaResposta(res).data.careTeamIds).toEqual(['prof-1']);
    });

    it('200 numa versão NÃO vigente: a permissão de contatos é a MESMA da vigente (lex C8(a)) — nenhum ramo por status', async () => {
      const versaoAntiga = { ...VERSAO, annulledAt: null, id: '99999999-bbbb-cccc-dddd-eeeeeeeeeeee' };
      const repo = { findById: jest.fn().mockResolvedValue(versaoAntiga) };
      const contacts = stubContacts();
      const res = mockRes();
      await ctrl(repo, {}, contacts).get(
        mockReq({ params: { id: PATIENT_ID, vid: versaoAntiga.id }, permissionCells: ['patient_family:read'] }),
        res,
      );
      // Mesma chamada, mesmas células — nada em `get` decide por `annulledAt`/"é a última".
      expect((contacts.resolve as jest.Mock)).toHaveBeenCalledWith(versaoAntiga.id, ['patient_family:read']);
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

    it('403 sem `patient_clinical:create`: a célula que falta é NOMEADA e o repo nem é chamado (lex C7)', async () => {
      const repo = { createVersion: jest.fn() };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_therapeutic_project:create'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_clinical:create' } });
      expect(repo.createVersion).not.toHaveBeenCalled();
    });

    it('403 sem `patient_family:read`: RESPONSIBLE/EXTERNAL selecionado sem a célula de origem (lex-pr7 §alterado)', async () => {
      const repo = { createVersion: jest.fn() };
      const res = mockRes();
      const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, contactRefs: [{ kind: 'RESPONSIBLE', id: PAT_ID }] } };
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: corpo, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_family:read' } });
      expect(repo.createVersion).not.toHaveBeenCalled();
    });

    it('403 sem `patient_coverage:read`: COVERAGE selecionado sem a célula de origem', async () => {
      const repo = { createVersion: jest.fn() };
      const res = mockRes();
      const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, contactRefs: [{ kind: 'COVERAGE', id: PAT_ID }] } };
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: corpo, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_coverage:read' } });
    });

    it('403 sem `patient_care_team:read`: `careTeamIds` sem a célula de origem', async () => {
      const repo = { createVersion: jest.fn() };
      const res = mockRes();
      const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, careTeamIds: [PAT_ID] } };
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: corpo, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_care_team:read' } });
    });

    it('403 sem `patient_care_team:read`: COVERAGE é DIRECT_PROFESSIONAL (contract `therapeutic-project.md:12`, lex C3)', async () => {
      const repo = { createVersion: jest.fn() };
      const coverageContacts = stubCoverageContacts({ [PAT_ID]: 'DIRECT_PROFESSIONAL' });
      const res = mockRes();
      const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, contactRefs: [{ kind: 'COVERAGE', id: PAT_ID }] } };
      await ctrl(repo, {}, stubContacts(), coverageContacts).create(
        mockReq({ params: { id: PATIENT_ID }, body: corpo, permissionCells: ['patient_clinical:write', 'patient_coverage:read'] }),
        res,
      );
      expect(coverageContacts.getKind).toHaveBeenCalledWith(PATIENT_ID, PAT_ID);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_care_team:read' } });
      expect(repo.createVersion).not.toHaveBeenCalled();
    });

    it('201: COVERAGE é DIRECT_PROFESSIONAL, mas o ator TEM `patient_care_team:read` — passa', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const coverageContacts = stubCoverageContacts({ [PAT_ID]: 'DIRECT_PROFESSIONAL' });
      const res = mockRes();
      const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, contactRefs: [{ kind: 'COVERAGE', id: PAT_ID }] } };
      await ctrl(repo, {}, stubContacts(), coverageContacts).create(
        mockReq({
          params: { id: PATIENT_ID },
          body: corpo,
          permissionCells: ['patient_clinical:write', 'patient_coverage:read', 'patient_care_team:read'],
        }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('201: COVERAGE não é DIRECT_PROFESSIONAL (kind normal) — não exige `patient_care_team:read`', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const coverageContacts = stubCoverageContacts({ [PAT_ID]: 'PUBLIC_EMERGENCY_SERVICE' });
      const res = mockRes();
      const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, contactRefs: [{ kind: 'COVERAGE', id: PAT_ID }] } };
      await ctrl(repo, {}, stubContacts(), coverageContacts).create(
        mockReq({ params: { id: PATIENT_ID }, body: corpo, permissionCells: ['patient_clinical:write', 'patient_coverage:read'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('`cells = null` (D113, engine não decidiu) pula a checagem inteira — o repo de cobertura nem é consultado', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const coverageContacts = stubCoverageContacts({ [PAT_ID]: 'DIRECT_PROFESSIONAL' });
      const res = mockRes();
      const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, contactRefs: [{ kind: 'COVERAGE', id: PAT_ID }] } };
      await ctrl(repo, {}, stubContacts(), coverageContacts).create(mockReq({ params: { id: PATIENT_ID }, body: corpo }), res);
      expect(coverageContacts.getKind).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('sem `coverageContacts` injetado (4º arg omitido): constrói a instância REAL só na 1ª chamada com `COVERAGE`, e MEMOIZA entre chamadas', async () => {
      const { PatientCoverageEmergencyContactRepository: RepoMock } = jest.requireMock(
        '../../../infrastructure/PatientCoverageEmergencyContactRepository',
      ) as { PatientCoverageEmergencyContactRepository: jest.Mock };
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const controller = novoController([repo, {}, stubContacts()]);
      const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, contactRefs: [{ kind: 'COVERAGE', id: PAT_ID }] } };
      // SEM `patient_care_team:read`: força o código a consultar o kind (getKind) — é essa consulta
      // que toca o getter `coverageContacts` e materializa a instância (o stub devolve `null`, não
      // DIRECT_PROFESSIONAL, então a criação segue e o efeito medido aqui é só a memoização).
      const cells = ['patient_clinical:write', 'patient_coverage:read'];
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: corpo, permissionCells: cells }), mockRes());
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: corpo, permissionCells: cells }), mockRes());
      expect(RepoMock).toHaveBeenCalledTimes(1);
    });

    it('201 com `contactRefs`/`careTeamIds` e as células de origem — nenhuma célula falta', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const res = mockRes();
      const corpo = {
        ...CORPO_NOVO,
        version: { ...CORPO_NOVO.version, contactRefs: [{ kind: 'RESPONSIBLE', id: PAT_ID }], careTeamIds: [PAT_ID] },
      };
      await ctrl(repo).create(
        mockReq({
          params: { id: PATIENT_ID },
          body: corpo,
          permissionCells: ['patient_clinical:write', 'patient_family:read', 'patient_care_team:read'],
        }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('409 `ptp_not_current` quando `fromVersionId` não é mais a vigente (ADR-4/SUP-24) — nunca 422', async () => {
      const { VersionNotCurrentError } = await import('../../../infrastructure/TherapeuticProjectRepository');
      const repo = { createVersion: jest.fn().mockRejectedValue(new VersionNotCurrentError()) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: { mode: 'edit', fromVersionId: SOURCE_ID, version: VERSAO_DO_EDIT }, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(409);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Only the current version can be edited', code: 'ptp_not_current' });
    });

    it('422 `ptp_macro_locked` com SÓ os nomes dos campos — nunca o valor (lex #7 C7/D328)', async () => {
      const { MacroFieldsLockedError } = await import('../../../infrastructure/TherapeuticProjectRepository');
      const repo = { createVersion: jest.fn().mockRejectedValue(new MacroFieldsLockedError(['clinicalContext', 'diagnoses'])) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: { mode: 'edit', fromVersionId: SOURCE_ID, version: VERSAO_DO_EDIT }, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(422);
      expect(corpoDaResposta(res)).toEqual({
        success: false,
        error: 'Macro fields are locked outside of a new version',
        code: 'ptp_macro_locked',
        details: { fields: ['clinicalContext', 'diagnoses'] },
      });
      expect(JSON.stringify(corpoDaResposta(res))).not.toContain(TEXTO_CLINICO);
    });

    it('422 `ptp_contact_inactive` com SÓ kind/id — nunca nome/telefone (lex #7 C7)', async () => {
      const { ContactInactiveError } = await import('../../../infrastructure/TherapeuticProjectRepository');
      const repo = { createVersion: jest.fn().mockRejectedValue(new ContactInactiveError('RESPONSIBLE', PAT_ID)) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(422);
      expect(corpoDaResposta(res)).toEqual({
        success: false,
        error: 'Selected contact is inactive',
        code: 'ptp_contact_inactive',
        details: { kind: 'RESPONSIBLE', id: PAT_ID },
      });
      expect(reportError).not.toHaveBeenCalled();
    });

    it('404 `contact_not_found` quando o id não é linha ATIVA deste paciente (FK 23503)', async () => {
      const { ContactNotFoundError } = await import('../../../infrastructure/TherapeuticProjectRepository');
      const repo = { createVersion: jest.fn().mockRejectedValue(new ContactNotFoundError('COVERAGE', PAT_ID)) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(404);
      expect(corpoDaResposta(res)).toEqual({
        success: false,
        error: 'Selected contact not found',
        code: 'contact_not_found',
        details: { kind: 'COVERAGE', id: PAT_ID },
      });
    });

    it('201 anexa `contacts`/`contactRefs`/`careTeamIds` resolvidos pela MESMA `resolveContacts` de `get` — nunca crus (conserto 14/09, contract §POST)', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const contacts = {
        resolve: jest.fn().mockResolvedValue({
          contacts: [{ kind: 'RESPONSIBLE', id: PAT_ID, name: 'Ana', phone: '+54...' }],
          containersServed: new Set(['family']),
          contactRefs: [{ kind: 'RESPONSIBLE', id: PAT_ID }],
          careTeamIds: [],
        }),
      };
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_clinical:write', 'patient_family:read'] });
      await ctrl(repo, {}, contacts).create(req, res);
      expect(contacts.resolve).toHaveBeenCalledWith(VERSION_ID, ['patient_clinical:write', 'patient_family:read']);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(corpoDaResposta(res).data.contacts).toEqual([{ kind: 'RESPONSIBLE', id: PAT_ID, name: 'Ana', phone: '+54...' }]);
      expect(corpoDaResposta(res).data.contactRefs).toEqual([{ kind: 'RESPONSIBLE', id: PAT_ID }]);
      expect(corpoDaResposta(res).data.careTeamIds).toEqual([]);
    });

    it('201 grava os containers de contato SERVIDOS em `req` — a trilha do POST (`writeTrail`) lê o MESMO campo do GET (lex C6/C9)', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const contacts = {
        resolve: jest.fn().mockResolvedValue({
          contacts: [{ kind: 'CARE_TEAM', id: 'prof-1', name: 'Dra. Souza', phone: null }],
          containersServed: new Set(['care_team']),
          contactRefs: [],
          careTeamIds: ['prof-1'],
        }),
      };
      const res = mockRes();
      const req = mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_clinical:write'] });
      await ctrl(repo, {}, contacts).create(req, res);
      expect((req as unknown as { therapeuticContactContainers: string[] }).therapeuticContactContainers).toEqual(['care_team']);
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
        mode: 'new', patientId: PATIENT_ID, actorUid: 'uid-1', cells: ['patient_clinical:write'], version: { ...CORPO_NOVO.version, contactRefs: [], careTeamIds: [] },
      });
      expect(corpoDaResposta(res).data.version).toBe('V.1.0');
    });

    it('201 no `new` com as células DIVIDIDAS (create), sem `write` — o que o painel de grupos de fato grava', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_therapeutic_project:create', 'patient_clinical:create'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(repo.createVersion).toHaveBeenCalledTimes(1);
    });

    it('`edit` exige `patient_clinical:update`: só `:create` → 403 nomeando `:update`; com `:update` → 201', async () => {
      const corpoEdit = { mode: 'edit', fromVersionId: SOURCE_ID, version: VERSAO_DO_EDIT };
      const repoNega = { createVersion: jest.fn() };
      const resNega = mockRes();
      await ctrl(repoNega).create(
        mockReq({ params: { id: PATIENT_ID }, body: corpoEdit, permissionCells: ['patient_clinical:create'] }),
        resNega,
      );
      expect(resNega.status).toHaveBeenCalledWith(403);
      expect(corpoDaResposta(resNega)).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_clinical:update' } });
      expect(repoNega.createVersion).not.toHaveBeenCalled();

      const repoOk = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const resOk = mockRes();
      await ctrl(repoOk).create(
        mockReq({ params: { id: PATIENT_ID }, body: corpoEdit, permissionCells: ['patient_clinical:update'] }),
        resOk,
      );
      expect(resOk.status).toHaveBeenCalledWith(201);
    });

    describe('030 — segmento (lex C3, C7)', () => {
      it('030 — o `segmentId` do corpo chega ao repositório no `new` (o `{id,label}` é do repositório, nunca do corpo)', async () => {
        const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
        const res = mockRes();
        await ctrl(repo).create(
          mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_clinical:read', 'patient_clinical:write'] }),
          res,
        );
        expect(res.status).toHaveBeenCalledWith(201);
        expect(repo.createVersion.mock.calls[0][0].version.segmentId).toBe(SEGMENT_ID);
        expect(corpoDaResposta(res).data.segment).toEqual({ id: SEGMENT_ID, label: 'AT para Pacientes con TEA' });
      });

      it('030 — 403 sem `patient_clinical:create` mesmo com `segmentId` válido: nomeia a célula e o repo nem é chamado', async () => {
        const repo = { createVersion: jest.fn() };
        const res = mockRes();
        await ctrl(repo).create(
          mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_therapeutic_project:create'] }),
          res,
        );
        expect(res.status).toHaveBeenCalledWith(403);
        expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_clinical:create' } });
        expect(JSON.stringify(corpoDaResposta(res))).not.toContain(SEGMENT_ID);
        expect(repo.createVersion).not.toHaveBeenCalled();
      });

      it('030 — sem `patient_clinical:read` a resposta do POST leva `segment: null` + marcador, e o rótulo não aparece na resposta inteira', async () => {
        const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
        const res = mockRes();
        await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_clinical:write'] }), res);
        expect(corpoDaResposta(res).data.segment).toBeNull();
        expect(corpoDaResposta(res).data.redacted.clinical).toBe(true);
        expect(JSON.stringify(corpoDaResposta(res))).not.toContain('AT para Pacientes con TEA');
      });

      it('030 — `logResourceAccess` só UUID: o POST escreve no `req` no máximo o campo de containers (nomes), nada de segmento', async () => {
        const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
        const req = mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_clinical:read', 'patient_clinical:write'] });
        const antes = Object.keys(req as object);
        await ctrl(repo).create(req, mockRes());
        const novas = Object.keys(req as object).filter((k) => !antes.includes(k));
        expect(novas.filter((k) => k !== 'therapeuticContactContainers')).toEqual([]);
        expect(JSON.stringify(req)).not.toContain('AT para Pacientes con TEA');
        expect(therapeuticTrailAction('write_project', ['patient_clinical:read'], (req as never as { therapeuticContactContainers?: string[] }).therapeuticContactContainers ?? []))
          .toMatch(/^write_project:[a-zA-Z_+]+$/);
      });
    });

    it('201 no `edit`: o `fromVersionId` do corpo chega ao repo', async () => {
      const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
      const res = mockRes();
      const corpo = { mode: 'edit', fromVersionId: SOURCE_ID, version: VERSAO_DO_EDIT };
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: corpo }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(repo.createVersion).toHaveBeenCalledWith({
        mode: 'edit', patientId: PATIENT_ID, actorUid: 'uid-1', cells: null, fromVersionId: SOURCE_ID, version: { ...VERSAO_DO_EDIT, contactRefs: [], careTeamIds: [] },
      });
    });

    describe('spec 048 — "Todavía no hay registro" / "No necesita"', () => {
      it('a LISTA traz as datas dos lembretes que faltam no ciclo aberto (null sem ciclo)', async () => {
        const repo = { listForPatient: jest.fn().mockResolvedValue([VERSAO]) };
        const reminders = { remainingReminderDates: jest.fn().mockResolvedValue(['2026-10-12', '2026-10-15', '2026-10-22']) };
        const res = mockRes();
        await ctrl(repo, {}, stubContacts(), stubCoverageContacts(), stubStatuses(), reminders).list(mockReq({ params: { id: PATIENT_ID } }), res);
        expect(corpoDaResposta(res).data.contactReminderDates).toEqual(['2026-10-12', '2026-10-15', '2026-10-22']);
        expect(reminders.remainingReminderDates).toHaveBeenCalledWith(PATIENT_ID);

        const sem = mockRes();
        await ctrl(repo).list(mockReq({ params: { id: PATIENT_ID } }), sem);
        expect(corpoDaResposta(sem).data.contactReminderDates).toBeNull();
      });

      it('"No necesita" novo sem a célula: 403 nomeando `patient_therapeutic_project:waive_contact` (só nomes de campo, nada de valor)', async () => {
        const repo = { createVersion: jest.fn().mockRejectedValue(new WaiveContactForbiddenError(['EXTERNAL'])) };
        const res = mockRes();
        const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, contactStatus: { EXTERNAL: 'NOT_NEEDED' } } };
        await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: corpo, permissionCells: ['patient_clinical:write'] }), res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(corpoDaResposta(res)).toMatchObject({ success: false, error: 'Forbidden', details: { cell: 'patient_therapeutic_project:waive_contact', fields: ['EXTERNAL'] } });
        expect(JSON.stringify(corpoDaResposta(res))).not.toContain(TEXTO_CLINICO);
        expect(reportError).not.toHaveBeenCalled();
      });

      it('ids + status no mesmo campo: 400 e o repo nem é chamado', async () => {
        const repo = { createVersion: jest.fn() };
        const res = mockRes();
        const corpo = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, contactStatus: { CARE_TEAM: 'PENDING' }, careTeamIds: [OBJ_ID] } };
        await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: corpo, permissionCells: ['patient_clinical:write'] }), res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(repo.createVersion).not.toHaveBeenCalled();
      });

      it('a resposta traz `contactStatus` com o vencimento (pendingSince + 15 dias no fuso) e SEM o uid de quem marcou', async () => {
        const repo = { createVersion: jest.fn().mockResolvedValue(VERSAO) };
        const statuses = stubStatuses({
          [VERSION_ID]: [
            { kind: 'CARE_TEAM', status: 'PENDING', pendingSince: new Date('2026-09-08T10:00:00.000Z'), markedByUid: 'uid-secreto' },
            { kind: 'RESPONSIBLE', status: 'NOT_NEEDED', pendingSince: null, markedByUid: 'uid-secreto' },
          ],
        });
        const res = mockRes();
        await ctrl(repo, {}, stubContacts(), stubCoverageContacts(), statuses).create(
          mockReq({ params: { id: PATIENT_ID }, body: CORPO_NOVO, permissionCells: ['patient_clinical:write'] }),
          res,
        );
        expect(corpoDaResposta(res).data.contactStatus).toEqual([
          { kind: 'RESPONSIBLE', status: 'NOT_NEEDED', pendingSince: null, deadlineDate: null },
          { kind: 'CARE_TEAM', status: 'PENDING', pendingSince: '2026-09-08T10:00:00.000Z', deadlineDate: '2026-09-23' },
        ]);
        expect(JSON.stringify(corpoDaResposta(res))).not.toContain('uid-secreto');
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
      await ctrl(repo).create(mockReq({ params: { id: PATIENT_ID }, body: { mode: 'edit', fromVersionId: SOURCE_ID, version: VERSAO_DO_EDIT } }), res);
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

  describe('listServiceExitReasonOptions (492)', () => {
    const exitCtrl = (reader: Record<string, unknown>) =>
      novoController([{}, {}, stubContacts(), stubCoverageContacts(), undefined, undefined, reader]);

    it('200 com `{ items: [{ code, label }] }` vindo só dos ativos (o reader é quem filtra `active`)', async () => {
      const reader = { listActiveOptions: jest.fn().mockResolvedValue([{ code: 'OTHER', label: 'Otro' }]) };
      const res = mockRes();
      await exitCtrl(reader).listServiceExitReasonOptions(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(reader.listActiveOptions).toHaveBeenCalledWith({ pool: 'fake' });
      expect(corpoDaResposta(res)).toEqual({ success: true, data: { items: [{ code: 'OTHER', label: 'Otro' }] } });
    });

    it('500 quando o reader lança', async () => {
      const reader = { listActiveOptions: jest.fn().mockRejectedValue(new Error('boom')) };
      const res = mockRes();
      await exitCtrl(reader).listServiceExitReasonOptions(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminTherapeuticProjectsController:listServiceExitReasonOptions' });
    });
  });

  describe('createCatalogItem', () => {
    it('400 quando o rótulo carrega dado de pessoa (lex C18) — só o nome do campo volta', async () => {
      const catalogs = { create: jest.fn() };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'contato 11 98765-4321', objectiveId: OBJ_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res)).toEqual({ success: false, error: 'Invalid body', details: { fields: ['label'] } });
      expect(catalogs.create).not.toHaveBeenCalled();
    });

    it('spec 061: repassa `description` ao create; 1001 → 400 só com o nome do campo, sem ecoar o texto (controle: 1000 passa)', async () => {
      const catalogs = { create: jest.fn().mockResolvedValue(ITEM) };
      const ok = mockRes();
      const dentro = 'DESCRIPCION-SINTETICA-' + 'a'.repeat(1000 - 'DESCRIPCION-SINTETICA-'.length);
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'TITULO-SINTETICO-1', description: dentro, objectiveId: OBJ_ID } }), ok);
      expect(ok.status).toHaveBeenCalledWith(201);
      expect(catalogs.create).toHaveBeenCalledWith('activities', { label: 'TITULO-SINTETICO-1', description: dentro, objectiveId: OBJ_ID, actorUid: 'uid-1' });
      const ruim = mockRes();
      const fora = 'DESCRIPCION-SINTETICA-' + 'b'.repeat(1001 - 'DESCRIPCION-SINTETICA-'.length);
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'TITULO-SINTETICO-1', description: fora, objectiveId: OBJ_ID } }), ruim);
      expect(ruim.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(ruim)).toEqual({ success: false, error: 'Invalid body', details: { fields: ['description'] } });
      expect(JSON.stringify(corpoDaResposta(ruim))).not.toContain('DESCRIPCION-SINTETICA');
      expect(catalogs.create).toHaveBeenCalledTimes(1);
    });

    it('201 com o rótulo e o ator carimbado', async () => {
      const catalogs = { create: jest.fn().mockResolvedValue(ITEM) };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('specific-objectives', mockReq({ body: { label: 'Vínculo terapéutico', sortOrder: 30, serviceCode: 'AT' } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(catalogs.create).toHaveBeenCalledWith('specific-objectives', { label: 'Vínculo terapéutico', sortOrder: 30, serviceCode: 'AT', actorUid: 'uid-1' });
      expect(corpoDaResposta(res)).toEqual({ success: true, data: ITEM });
    });

    it('409 quando o rótulo já existe entre os ATIVOS', async () => {
      const catalogs = { create: jest.fn().mockRejectedValue(new CatalogLabelTakenError()) };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'Repetido', objectiveId: OBJ_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(corpoDaResposta(res)).toMatchObject({ code: 'catalog_label_taken' });
      expect(reportError).not.toHaveBeenCalled();
    });

    it('091: `segmentId` no corpo → 400 (strict: o catálogo de segmentos acabou), sem ecoar o valor, e o repositório nem é chamado', async () => {
      const catalogs = { create: jest.fn() };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'X', objectiveId: ITEM_ID, segmentId: PAT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(corpoDaResposta(res)).toMatchObject({ success: false, error: 'Invalid body' });
      expect(JSON.stringify(corpoDaResposta(res))).not.toContain(PAT_ID);
      expect(catalogs.create).not.toHaveBeenCalled();
    });

    it('500 no erro genérico', async () => {
      const catalogs = { create: jest.fn().mockRejectedValue(new Error('boom')) };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'X', objectiveId: OBJ_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
        source: 'AdminTherapeuticProjectsController:createCatalogItem',
        kind: 'activities',
      });
    });

    it('500 quando a rejeição não é Error', async () => {
      const catalogs = { create: jest.fn().mockRejectedValue('rejeição crua') };
      const res = mockRes();
      await ctrl({}, catalogs).createCatalogItem('activities', mockReq({ body: { label: 'X', objectiveId: OBJ_ID } }), res);
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

    it('spec 061: update só com `description` repassa a descrição (sem label); `null` limpa', async () => {
      const catalogs = { update: jest.fn().mockResolvedValue(ITEM) };
      const res = mockRes();
      await ctrl({}, catalogs).updateCatalogItem('activities', mockReq({ params: { itemId: ITEM_ID }, body: { description: 'DESCRIPCION-SINTETICA-2' } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(catalogs.update).toHaveBeenLastCalledWith('activities', ITEM_ID, { description: 'DESCRIPCION-SINTETICA-2', actorUid: 'uid-1' });
      await ctrl({}, catalogs).updateCatalogItem('activities', mockReq({ params: { itemId: ITEM_ID }, body: { description: null } }), mockRes());
      expect(catalogs.update).toHaveBeenLastCalledWith('activities', ITEM_ID, { description: null, actorUid: 'uid-1' });
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

    it('091: `segmentId` no PATCH → 400 e o repositório nem é chamado', async () => {
      const catalogs = { update: jest.fn() };
      const res = mockRes();
      await ctrl({}, catalogs).updateCatalogItem('activities', mockReq({ params: { itemId: ITEM_ID }, body: { segmentId: PAT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(catalogs.update).not.toHaveBeenCalled();
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

  // ── 091: catálogo por CID — cascata, busca, vínculos e tabela erro→status (§9.4) ─────────────
  describe('091 — catálogo por CID', () => {
    const URI_CLINICA = 'http://id.who.int/icd/entity/URI-SINTETICA-1';
    /** Controller com os três colaboradores novos injetados (a fronteira; o SQL é do e2e). */
    const ctrl091 = (parts: { catalogs?: Record<string, unknown>; cascade?: Record<string, unknown>; links?: Record<string, unknown>; icd?: Record<string, unknown> }) =>
      novoController(
        [{}, parts.catalogs ?? {}, stubContacts(), stubCoverageContacts(), stubStatuses(), { remainingReminderDates: jest.fn().mockResolvedValue(null) }],
        [parts.cascade ?? PORTAS_091[0], parts.links ?? PORTAS_091[1], parts.icd ?? PORTAS_091[2]],
      );

    describe('tabela erro→status (um caso por linha da tabela)', () => {
      it.each([
        ['catalog_label_taken', new CatalogLabelTakenError(), 409],
        ['catalog_item_needs_owner', new CatalogItemNeedsOwnerError(), 422],
        ['catalog_objective_invalid', new CatalogObjectiveInvalidError(), 422],
        ['catalog_service_invalid', new CatalogServiceInvalidError(), 422],
        ['activity_categories_outside_objective', new ActivityCategoriesOutsideObjectiveError(), 409],
      ])('POST/PATCH de catálogo: %s → %i, só o tipo do erro, sem reportError', async (code, erro, status) => {
        const res = mockRes();
        await ctrl091({ catalogs: { create: jest.fn().mockRejectedValue(erro) } }).createCatalogItem('activities', mockReq({ body: { label: 'X', objectiveId: OBJ_ID } }), res);
        expect(res.status).toHaveBeenCalledWith(status);
        expect(corpoDaResposta(res)).toMatchObject({ success: false, code });
        expect(JSON.stringify(corpoDaResposta(res))).not.toContain(OBJ_ID);
        expect(reportError).not.toHaveBeenCalled();
      });

      it.each([
        ['icd_category_not_in_objective', new IcdCategoryNotInObjectiveError(), 422],
        ['icd_category_already_linked', new IcdCategoryAlreadyLinkedError(), 409],
        ['icd_category_invalid', new InvalidIcdCategoryCodeError(), 422],
        ['catalog_item_not_found', new CatalogLinkOwnerNotFoundError(), 404],
      ])('POST de vínculo: %s → %i', async (code, erro, status) => {
        const res = mockRes();
        await ctrl091({ links: { addActivityCategory: jest.fn().mockRejectedValue(erro) } }).addCategoryLink('activity', mockReq({ params: { itemId: ITEM_ID }, body: { code: '6A02' } }), res);
        expect(res.status).toHaveBeenCalledWith(status);
        expect(corpoDaResposta(res)).toMatchObject({ success: false, code });
        expect(reportError).not.toHaveBeenCalled();
      });
    });

    describe('create/update com os campos novos', () => {
      it('objetivo sem `serviceCode` → 400 (obrigatório); com `segmentId` → 400 (strict); serviceCode minúsculo → 400', async () => {
        const catalogs = { create: jest.fn() };
        for (const body of [{ label: 'X' }, { label: 'X', serviceCode: 'AT', segmentId: PAT_ID }, { label: 'X', serviceCode: 'at' }]) {
          const res = mockRes();
          await ctrl091({ catalogs }).createCatalogItem('specific-objectives', mockReq({ body }), res);
          expect(res.status).toHaveBeenCalledWith(400);
        }
        expect(catalogs.create).not.toHaveBeenCalled();
      });

      it('atividade sem `objectiveId` → 400; `suggestedFrequency` 101 chars → 400; `null` e 100 chars passam e chegam ao repositório', async () => {
        const catalogs = { create: jest.fn().mockResolvedValue(ITEM) };
        for (const body of [{ label: 'X' }, { label: 'X', objectiveId: OBJ_ID, suggestedFrequency: 'f'.repeat(101) }]) {
          const res = mockRes();
          await ctrl091({ catalogs }).createCatalogItem('activities', mockReq({ body }), res);
          expect(res.status).toHaveBeenCalledWith(400);
        }
        expect(catalogs.create).not.toHaveBeenCalled();
        const ok = mockRes();
        await ctrl091({ catalogs }).createCatalogItem('activities', mockReq({ body: { label: 'X', objectiveId: OBJ_ID, suggestedFrequency: null } }), ok);
        expect(ok.status).toHaveBeenCalledWith(201);
        expect(catalogs.create).toHaveBeenCalledWith('activities', { label: 'X', objectiveId: OBJ_ID, suggestedFrequency: null, actorUid: 'uid-1' });
      });

      it('PATCH de atividade aceita `objectiveId`/`suggestedFrequency`; PATCH de objetivo aceita `serviceCode` e recusa `objectiveId`', async () => {
        const catalogs = { update: jest.fn().mockResolvedValue(ITEM) };
        const a = mockRes();
        await ctrl091({ catalogs }).updateCatalogItem('activities', mockReq({ params: { itemId: ITEM_ID }, body: { objectiveId: OBJ_ID, suggestedFrequency: '3x por semana' } }), a);
        expect(a.status).toHaveBeenCalledWith(200);
        const o = mockRes();
        await ctrl091({ catalogs }).updateCatalogItem('specific-objectives', mockReq({ params: { itemId: ITEM_ID }, body: { serviceCode: 'AT' } }), o);
        expect(o.status).toHaveBeenCalledWith(200);
        const bad = mockRes();
        await ctrl091({ catalogs }).updateCatalogItem('specific-objectives', mockReq({ params: { itemId: ITEM_ID }, body: { objectiveId: OBJ_ID } }), bad);
        expect(bad.status).toHaveBeenCalledWith(400);
        expect(catalogs.update).toHaveBeenCalledTimes(2);
      });
    });

    describe('listCatalog com filtros', () => {
      it('`categoryCode` e `objectiveId` válidos chegam ao repositório; `includeInactive` só vale como "true"', async () => {
        const catalogs = { list: jest.fn().mockResolvedValue([]) };
        await ctrl091({ catalogs }).listCatalog('activities', mockReq({ query: { categoryCode: '6A02', objectiveId: OBJ_ID, includeInactive: 'true' } }), mockRes());
        expect(catalogs.list).toHaveBeenCalledWith('activities', { includeInactive: true, categoryCode: '6A02', objectiveId: OBJ_ID });
        await ctrl091({ catalogs }).listCatalog('activities', mockReq({ query: {} }), mockRes());
        expect(catalogs.list).toHaveBeenLastCalledWith('activities', { includeInactive: false });
      });

      it('`categoryCode` que não tem 4 caracteres → 400 e o repositório não é chamado', async () => {
        const catalogs = { list: jest.fn() };
        const res = mockRes();
        await ctrl091({ catalogs }).listCatalog('specific-objectives', mockReq({ query: { categoryCode: '6A0' } }), res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(catalogs.list).not.toHaveBeenCalled();
      });
    });

    describe('cascade (DD-10)', () => {
      const VIEW = { serviceCode: 'AT', serviceHasCatalog: true, blocks: [] };
      const CORPO = { serviceCode: 'AT', diagnosisUris: [URI_CLINICA] };

      it('200 com o resultado do caso de uso, repassando o corpo validado', async () => {
        const cascade = { execute: jest.fn().mockResolvedValue(VIEW) };
        const res = mockRes();
        await ctrl091({ cascade }).cascade(mockReq({ body: CORPO }), res);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(cascade.execute).toHaveBeenCalledWith(CORPO);
        expect(corpoDaResposta(res)).toEqual({ success: true, data: VIEW });
      });

      it.each([
        ['sem URIs', { serviceCode: 'AT', diagnosisUris: [] }],
        ['21 URIs', { serviceCode: 'AT', diagnosisUris: Array.from({ length: 21 }, (_, i) => `u${i}`) }],
        ['URI de 501 chars', { serviceCode: 'AT', diagnosisUris: ['u'.repeat(501)] }],
        ['serviceCode inválido', { serviceCode: 'at-x', diagnosisUris: ['u'] }],
        ['chave extra (strict)', { serviceCode: 'AT', diagnosisUris: ['u'], segmentId: PAT_ID }],
      ])('400 %s — só nomes de campo, a URI nunca volta', async (_nome, body) => {
        const cascade = { execute: jest.fn() };
        const res = mockRes();
        await ctrl091({ cascade }).cascade(mockReq({ body }), res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(cascade.execute).not.toHaveBeenCalled();
      });

      it('422 ptp_diagnosis_unknown SEM ecoar a URI; 503 com a terminologia fora; nenhum dos dois vai a reportError', async () => {
        const unknown = mockRes();
        await ctrl091({ cascade: { execute: jest.fn().mockRejectedValue(new DiagnosisUnknownError()) } }).cascade(mockReq({ body: CORPO }), unknown);
        expect(unknown.status).toHaveBeenCalledWith(422);
        expect(corpoDaResposta(unknown)).toMatchObject({ code: 'ptp_diagnosis_unknown' });
        expect(JSON.stringify(corpoDaResposta(unknown))).not.toContain('URI-SINTETICA');
        const fora = mockRes();
        await ctrl091({ cascade: { execute: jest.fn().mockRejectedValue(new TerminologyUnavailableError('terminology down')) } }).cascade(mockReq({ body: CORPO }), fora);
        expect(fora.status).toHaveBeenCalledWith(503);
        expect(corpoDaResposta(fora)).toMatchObject({ code: 'TERMINOLOGY_UNAVAILABLE' });
        expect(reportError).not.toHaveBeenCalled();
      });

      it('500 no erro desconhecido: o contexto do log não carrega URI nem corpo', async () => {
        const res = mockRes();
        await ctrl091({ cascade: { execute: jest.fn().mockRejectedValue(new Error('boom')) } }).cascade(mockReq({ body: CORPO }), res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect((reportError as jest.Mock).mock.calls[0][1]).toEqual({ source: 'AdminTherapeuticProjectsController:cascade' });
      });
    });

    describe('icd-categories?q=', () => {
      it('q com menos de 2 caracteres (após o trim) → 400; com 2+ → 200 e a porta recebe o q aparado', async () => {
        const icd = { search: jest.fn().mockResolvedValue([{ code: '6A02', title: 'TEA' }]) };
        const curto = mockRes();
        await ctrl091({ icd }).searchIcdCategories(mockReq({ query: { q: ' a ' } }), curto);
        expect(curto.status).toHaveBeenCalledWith(400);
        expect(icd.search).not.toHaveBeenCalled();
        const ok = mockRes();
        await ctrl091({ icd }).searchIcdCategories(mockReq({ query: { q: ' 6a ' } }), ok);
        expect(icd.search).toHaveBeenCalledWith('6a');
        expect(corpoDaResposta(ok)).toEqual({ success: true, data: [{ code: '6A02', title: 'TEA' }] });
      });
    });

    describe('vínculos com categoria (o dono vem da rota)', () => {
      const LISTA = { total: 1, items: [{ code: '6A02', title: 'TEA', activityLinks: 0 }] };

      it('objetivo: GET lista, POST 201 com o ator, DELETE 200 com removedActivityLinks', async () => {
        const links = {
          listObjectiveCategories: jest.fn().mockResolvedValue(LISTA),
          addObjectiveCategory: jest.fn().mockResolvedValue({ code: '6A02', title: 'TEA' }),
          removeObjectiveCategory: jest.fn().mockResolvedValue({ removedActivityLinks: 2 }),
        };
        const c = ctrl091({ links });
        const l = mockRes();
        await c.listCategoryLinks('objective', mockReq({ params: { itemId: ITEM_ID } }), l);
        expect(corpoDaResposta(l)).toEqual({ success: true, data: LISTA });
        const a = mockRes();
        await c.addCategoryLink('objective', mockReq({ params: { itemId: ITEM_ID }, body: { code: '6A02' } }), a);
        expect(a.status).toHaveBeenCalledWith(201);
        expect(links.addObjectiveCategory).toHaveBeenCalledWith(ITEM_ID, '6A02', 'uid-1');
        const d = mockRes();
        await c.removeCategoryLink('objective', mockReq({ params: { itemId: ITEM_ID, code: '6A02' } }), d);
        expect(d.status).toHaveBeenCalledWith(200);
        expect(corpoDaResposta(d)).toEqual({ success: true, data: { removedActivityLinks: 2 } });
      });

      it('atividade: usa os métodos de atividade (nunca os do objetivo)', async () => {
        const links = {
          listActivityCategories: jest.fn().mockResolvedValue({ total: 0, items: [] }),
          addActivityCategory: jest.fn().mockResolvedValue({ code: '6A02', title: null }),
          removeActivityCategory: jest.fn().mockResolvedValue({ removed: true }),
          listObjectiveCategories: jest.fn(),
          addObjectiveCategory: jest.fn(),
          removeObjectiveCategory: jest.fn(),
        };
        const c = ctrl091({ links });
        await c.listCategoryLinks('activity', mockReq({ params: { itemId: ITEM_ID } }), mockRes());
        await c.addCategoryLink('activity', mockReq({ params: { itemId: ITEM_ID }, body: { code: '6A02' } }), mockRes());
        await c.removeCategoryLink('activity', mockReq({ params: { itemId: ITEM_ID, code: '6A02' } }), mockRes());
        expect(links.listActivityCategories).toHaveBeenCalledWith(ITEM_ID);
        expect(links.addActivityCategory).toHaveBeenCalledWith(ITEM_ID, '6A02', 'uid-1');
        expect(links.removeActivityCategory).toHaveBeenCalledWith(ITEM_ID, '6A02');
        expect(links.listObjectiveCategories).not.toHaveBeenCalled();
        expect(links.addObjectiveCategory).not.toHaveBeenCalled();
        expect(links.removeObjectiveCategory).not.toHaveBeenCalled();
      });

      it('400 com :itemId que não é UUID, corpo sem `code` ou com chave extra; `code` malformado vai ao domínio (422), não ao zod', async () => {
        const links = { addObjectiveCategory: jest.fn().mockRejectedValue(new InvalidIcdCategoryCodeError()), removeObjectiveCategory: jest.fn() };
        const c = ctrl091({ links });
        const r1 = mockRes();
        await c.addCategoryLink('objective', mockReq({ params: { itemId: 'nao-uuid' }, body: { code: '6A02' } }), r1);
        const r2 = mockRes();
        await c.addCategoryLink('objective', mockReq({ params: { itemId: ITEM_ID }, body: {} }), r2);
        const r3 = mockRes();
        await c.addCategoryLink('objective', mockReq({ params: { itemId: ITEM_ID }, body: { code: '6A02', objectiveId: OBJ_ID } }), r3);
        const r4 = mockRes();
        await c.removeCategoryLink('objective', mockReq({ params: { itemId: 'nao-uuid', code: '6A02' } }), r4);
        for (const r of [r1, r2, r3, r4]) expect(r.status).toHaveBeenCalledWith(400);
        const r5 = mockRes();
        await c.addCategoryLink('objective', mockReq({ params: { itemId: ITEM_ID }, body: { code: 'xx' } }), r5);
        expect(r5.status).toHaveBeenCalledWith(422);
        expect(corpoDaResposta(r5)).toMatchObject({ code: 'icd_category_invalid' });
      });

      it('500 no erro desconhecido: o log leva owner e itemId, nunca o `code` nem o corpo', async () => {
        const res = mockRes();
        await ctrl091({ links: { addObjectiveCategory: jest.fn().mockRejectedValue(new Error('boom')) } }).addCategoryLink('objective', mockReq({ params: { itemId: ITEM_ID }, body: { code: '6A02' } }), res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect((reportError as jest.Mock).mock.calls[0][1]).toEqual({ source: 'AdminTherapeuticProjectsController:addCategoryLink', owner: 'objective', itemId: ITEM_ID });
      });
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
      await c.createCatalogItem('activities', req({ body: { label: 'Rótulo válido', objectiveId: OBJ_ID } }), mockRes());
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

  /**
   * lex-pr7 C7 (checklist condição 7): `ptp_macro_locked`, `ptp_contact_inactive` e `ptp_not_current`
   * respondem SEM tocar `reportError` — a SENTINELA no corpo prova isso por AUSÊNCIA em qualquer
   * chamada do espião E no corpo da resposta, não por leitura do código. O controle positivo (mesmo
   * arquivo) prova que o espião FUNCIONA: um erro genérico É capturado por ele.
   */
  describe('lex-pr7 C7 — sentinela: nenhum dos 3 erros nomeados vaza o corpo para o log nem para a resposta', () => {
    const SENTINELA = 'SENTINELA-PR7-NAO-VAZA';
    const corpoComSentinela = { ...CORPO_NOVO, version: { ...CORPO_NOVO.version, clinicalContext: SENTINELA, generalObjective: SENTINELA } };
    const versaoSentinelaEdit = { ...VERSAO_DO_EDIT, clinicalContext: SENTINELA, generalObjective: SENTINELA };

    const semSentinelaEmLugarNenhum = (res: ReturnType<typeof mockRes>): void => {
      // 1) nenhuma chamada do espião de log carrega a sentinela — nem no corpo, nem no contexto.
      for (const call of (reportError as jest.Mock).mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINELA);
      }
      // 2) o corpo da RESPOSTA HTTP também não — os 3 erros só devolvem nomes de campo/kind/id.
      expect(JSON.stringify(corpoDaResposta(res))).not.toContain(SENTINELA);
    };

    it('409 `ptp_not_current`: SENTINELA não aparece no espião nem na resposta', async () => {
      const { VersionNotCurrentError } = await import('../../../infrastructure/TherapeuticProjectRepository');
      const repo = { createVersion: jest.fn().mockRejectedValue(new VersionNotCurrentError()) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: { mode: 'edit', fromVersionId: SOURCE_ID, version: versaoSentinelaEdit }, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(409);
      expect(reportError).not.toHaveBeenCalled();
      semSentinelaEmLugarNenhum(res);
    });

    it('422 `ptp_macro_locked`: SENTINELA não aparece no espião nem na resposta (só os NOMES dos campos)', async () => {
      const { MacroFieldsLockedError } = await import('../../../infrastructure/TherapeuticProjectRepository');
      const repo = { createVersion: jest.fn().mockRejectedValue(new MacroFieldsLockedError(['clinicalContext', 'generalObjective'])) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: { mode: 'edit', fromVersionId: SOURCE_ID, version: versaoSentinelaEdit }, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(422);
      expect(reportError).not.toHaveBeenCalled();
      semSentinelaEmLugarNenhum(res);
    });

    it('422 `ptp_contact_inactive`: SENTINELA não aparece no espião nem na resposta (só `kind`/`id`)', async () => {
      const { ContactInactiveError } = await import('../../../infrastructure/TherapeuticProjectRepository');
      const repo = { createVersion: jest.fn().mockRejectedValue(new ContactInactiveError('RESPONSIBLE', PAT_ID)) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: corpoComSentinela, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(422);
      expect(reportError).not.toHaveBeenCalled();
      semSentinelaEmLugarNenhum(res);
    });

    it('CONTROLE POSITIVO: erro genérico (500) É capturado pelo espião — prova que o espião funciona de verdade', async () => {
      const repo = { createVersion: jest.fn().mockRejectedValue(new Error('boom genérico')) };
      const res = mockRes();
      await ctrl(repo).create(
        mockReq({ params: { id: PATIENT_ID }, body: corpoComSentinela, permissionCells: ['patient_clinical:write'] }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledTimes(1);
      // O controle É capturado (ao contrário dos 3 casos acima) — mas o CONTEXTO do log (2º arg)
      // continua sem a sentinela: só o objeto Error passa, nunca `req.body` (lex C6).
      expect((reportError as jest.Mock).mock.calls[0][0]).toBeInstanceOf(Error);
      expect(JSON.stringify((reportError as jest.Mock).mock.calls[0][1])).not.toContain(SENTINELA);
    });
  });
});
