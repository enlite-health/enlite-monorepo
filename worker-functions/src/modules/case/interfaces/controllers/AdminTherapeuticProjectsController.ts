import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { cellsOfRequest } from '@modules/identity/permissions';
import {
  TherapeuticProjectRepository,
  ServiceNotOfPatientError,
  SourceVersionNotFoundError,
  PatientNotFoundForProjectError,
  VersionNotCurrentError,
  MacroFieldsLockedError,
  ContactInactiveError,
  ContactNotFoundError,
} from '../../infrastructure/TherapeuticProjectRepository';
import { TherapeuticProjectContactsRepository } from '../../infrastructure/TherapeuticProjectContactsRepository';
import {
  TherapeuticCatalogRepository,
  CatalogItemsUnknownError,
  CatalogLabelTakenError,
  CatalogSegmentInvalidError,
} from '../../infrastructure/TherapeuticCatalogRepository';
import { PatientCoverageEmergencyContactRepository } from '../../infrastructure/PatientCoverageEmergencyContactRepository';
import {
  canWriteTherapeuticClinical,
  projectTherapeuticVersionForActor,
  missingContactOriginCell,
  missingCoverageDirectProfessionalCell,
  PATIENT_CLINICAL_WRITE_CELL,
} from '../../application/therapeuticProjectAccess';
import type { ResolvedTherapeuticContact } from '../../domain/TherapeuticProject';
import {
  createTherapeuticProjectSchema,
  annulTherapeuticProjectSchema,
  createCatalogItemSchemaFor,
  updateCatalogItemSchemaFor,
} from '../validators/therapeuticProjectSchemas';
import type { TherapeuticCatalogKind } from '../../domain/TherapeuticProject';
import { THERAPEUTIC_FIELD_CLASS } from '../../domain/TherapeuticProject';
import { DiagnosisUnknownError } from '../../application/pathologySegments';
import { TerminologyUnavailableError } from '@modules/terminology/domain/UnavailableTerminology';

const patientParamsSchema = z.object({ id: z.string().uuid() });
const versionParamsSchema = z.object({ id: z.string().uuid(), vid: z.string().uuid() });
const catalogItemParamsSchema = z.object({ itemId: z.string().uuid() });

const invalidBody = (res: Response, error: z.ZodError): void => {
  // Só NOMES de campo, nunca o valor: o corpo carrega texto clínico (lex C6).
  res.status(400).json({ success: false, error: 'Invalid body', details: { fields: Object.keys(error.flatten().fieldErrors) } });
};

/**
 * AdminTherapeuticProjectsController — o Projeto Terapêutico versionado (spec 017, D299) e os
 * seus 2 catálogos (o "tipo de patologia" deriva dos CID-11 — não é catálogo).
 *
 *   GET  /api/admin/patients/:id/therapeutic-projects              (patient_therapeutic_project:read)
 *   POST /api/admin/patients/:id/therapeutic-projects              (…:write + patient_clinical:write)
 *   GET  /api/admin/patients/:id/therapeutic-projects/:vid         (…:read; `?purpose=export` → trilha export_pdf)
 *   POST /api/admin/patients/:id/therapeutic-projects/:vid/annul   (…:write)
 *   GET/POST  /api/admin/therapeutic-catalogs/:kind                (catalog_<kind>:read|write)
 *   PATCH     /api/admin/therapeutic-catalogs/:kind/:itemId        (catalog_<kind>:write)
 *
 * Sem DELETE em lugar nenhum: versão é imutável (lex C5) e catálogo é soft delete.
 * `clinicalContext`/`generalObjective`/`diagnoses`/`pathologyTypes` (capítulo CID-11 derivado) saem só
 * com `patient_clinical:read` — a projeção é o ponto único `projectTherapeuticVersionForActor`. Nenhum `reportError` abaixo
 * carrega `req.body`.
 */
/** Onde a trilha (`therapeuticTrailAction`, lex C6) lê os containers de contato EFETIVAMENTE servidos — ver `adminTherapeuticProjectsRoutes.ts`. */
export interface RequestWithTherapeuticContactContainers extends Request {
  therapeuticContactContainers?: string[];
}

export class AdminTherapeuticProjectsController {
  constructor(
    private readonly repo: TherapeuticProjectRepository = new TherapeuticProjectRepository(),
    private readonly catalogs: TherapeuticCatalogRepository = new TherapeuticCatalogRepository(),
    private readonly contacts: TherapeuticProjectContactsRepository = new TherapeuticProjectContactsRepository(),
    // Injetado LAZY (molde das outras 3 acima): construir aqui em cima tocaria o pool no
    // construtor sem repo (PatientCoverageEmergencyContactRepository NÃO tem getter preguiçoso).
    private readonly coverageContactsInjected?: PatientCoverageEmergencyContactRepository,
  ) {}

  private coverageContactsMemo?: PatientCoverageEmergencyContactRepository;
  /** lex-pr7 §alterado: só é criado (e só toca o pool) quando `create()` de fato precisa checar um `COVERAGE` ref. */
  private get coverageContacts(): PatientCoverageEmergencyContactRepository {
    return (this.coverageContactsMemo ??= this.coverageContactsInjected ?? new PatientCoverageEmergencyContactRepository());
  }

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  /** Resolve os contatos de UMA versão + acumula os containers servidos em `req` para a trilha (lex C6). */
  private async resolveContacts(
    req: RequestWithTherapeuticContactContainers,
    versionId: string,
    cells: readonly string[] | null | undefined,
  ): Promise<ResolvedTherapeuticContact[]> {
    const { contacts, containersServed } = await this.contacts.resolve(versionId, cells);
    if (containersServed.size > 0) {
      const acc = new Set(req.therapeuticContactContainers ?? []);
      for (const c of containersServed) acc.add(c);
      req.therapeuticContactContainers = Array.from(acc);
    }
    return contacts;
  }

  /** GET /patients/:id/therapeutic-projects */
  async list(req: Request, res: Response): Promise<void> {
    const params = patientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    try {
      const versions = await this.repo.listForPatient(params.data.id);
      const cells = cellsOfRequest(req);
      const projected = await Promise.all(
        versions.map(async (v) => ({
          ...projectTherapeuticVersionForActor(v, cells),
          contacts: await this.resolveContacts(req, v.id, cells),
        })),
      );
      res.status(200).json({
        success: true,
        data: {
          versions: projected,
          // task 7.7: dono único é THERAPEUTIC_FIELD_CLASS (domain) — o front NÃO copia a lista,
          // lê aqui pra decidir quais campos da vigente renderizam como TEXTO na edição (D328/R5).
          fieldClass: { macro: [...THERAPEUTIC_FIELD_CLASS.MACRO], micro: [...THERAPEUTIC_FIELD_CLASS.MICRO] },
        },
      });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTherapeuticProjectsController:list', patientId: params.data.id });
      res.status(500).json({ success: false, error: 'Failed to list therapeutic projects' });
    }
  }

  /** GET /patients/:id/therapeutic-projects/:vid */
  async get(req: Request, res: Response): Promise<void> {
    const params = versionParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    try {
      const version = await this.repo.findById(params.data.id, params.data.vid);
      if (!version) {
        res.status(404).json({ success: false, error: 'Therapeutic project version not found' });
        return;
      }
      const cells = cellsOfRequest(req);
      // lex C8(a): a permissão de leitura da versão ANTIGA é a MESMA da vigente — nenhum ramo
      // especial por `annulledAt`/"não é a última": a projeção e a resolução de contatos são
      // por CÉLULA, sempre, nunca por status da versão.
      const contacts = await this.resolveContacts(req, version.id, cells);
      res.status(200).json({ success: true, data: { ...projectTherapeuticVersionForActor(version, cells), contacts } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTherapeuticProjectsController:get', patientId: params.data.id, versionId: params.data.vid });
      res.status(500).json({ success: false, error: 'Failed to load therapeutic project version' });
    }
  }

  /** POST /patients/:id/therapeutic-projects — `mode: 'new'` (major+1.0) | `mode: 'edit'` (minor+1). */
  async create(req: Request, res: Response): Promise<void> {
    const params = patientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = createTherapeuticProjectSchema.safeParse(req.body);
    if (!body.success) {
      invalidBody(res, body.error);
      return;
    }
    // lex C7: o corpo É texto clínico — a célula do container clínico é cumulativa à do projeto.
    const cells = cellsOfRequest(req);
    if (!canWriteTherapeuticClinical(cells)) {
      res.status(403).json({ success: false, error: 'Forbidden', details: { cell: PATIENT_CLINICAL_WRITE_CELL } });
      return;
    }
    // lex-pr7 §alterado: célula de escrita do projeto + célula de LEITURA da origem de cada
    // contato selecionado — quem não vê o familiar/cobertura/equipe não pode selecioná-lo.
    const missingCell = missingContactOriginCell(body.data.version.contactRefs, body.data.version.careTeamIds, cells);
    if (missingCell) {
      res.status(403).json({ success: false, error: 'Forbidden', details: { cell: missingCell } });
      return;
    }
    // contract `therapeutic-project.md:12`: COVERAGE exige `patient_care_team:read` A MAIS quando o
    // id referenciado é um contato DIRECT_PROFESSIONAL (mesma régua do `refuseDirectProfessionalWithoutCareTeam`
    // do support-network, lex C3) — quem não vê o profissional direto não pode selecioná-lo aqui também.
    const missingDirectProfessionalCell = await missingCoverageDirectProfessionalCell(
      body.data.version.contactRefs,
      cells,
      (id) => this.coverageContacts.getKind(params.data.id, id),
    );
    if (missingDirectProfessionalCell) {
      res.status(403).json({ success: false, error: 'Forbidden', details: { cell: missingDirectProfessionalCell } });
      return;
    }
    try {
      const actorUid = this.actorUid(req);
      const created = body.data.mode === 'new'
        ? await this.repo.createVersion({ mode: 'new', patientId: params.data.id, actorUid, version: body.data.version })
        : await this.repo.createVersion({ mode: 'edit', patientId: params.data.id, actorUid, fromVersionId: body.data.fromVersionId, version: body.data.version });
      res.status(201).json({ success: true, data: projectTherapeuticVersionForActor(created, cells) });
    } catch (err: unknown) {
      if (err instanceof PatientNotFoundForProjectError) {
        res.status(404).json({ success: false, error: 'Patient not found', code: err.code });
        return;
      }
      if (err instanceof SourceVersionNotFoundError) {
        res.status(404).json({ success: false, error: 'Source version not found', code: err.code });
        return;
      }
      // ADR-4/SUP-24: a versão existe mas não é mais a vigente — 409, nunca 422 (lex-pr7 contract §alterado).
      if (err instanceof VersionNotCurrentError) {
        res.status(409).json({ success: false, error: 'Only the current version can be edited', code: err.code });
        return;
      }
      // D328: só NOMES de campo — nunca o valor clínico enviado (lex #7 C7).
      if (err instanceof MacroFieldsLockedError) {
        res.status(422).json({ success: false, error: 'Macro fields are locked outside of a new version', code: err.code, details: { fields: err.fields } });
        return;
      }
      // lex #7 C7: só `kind`/`id` — nunca nome/telefone do contato (nem no erro, nem no log).
      if (err instanceof ContactInactiveError) {
        res.status(422).json({ success: false, error: 'Selected contact is inactive', code: err.code, details: { kind: err.kind, id: err.id } });
        return;
      }
      if (err instanceof ContactNotFoundError) {
        res.status(404).json({ success: false, error: 'Selected contact not found', code: err.code, details: { kind: err.kind, id: err.id } });
        return;
      }
      if (err instanceof ServiceNotOfPatientError) {
        res.status(422).json({ success: false, error: 'contractedServiceId does not belong to this patient', code: err.code });
        return;
      }
      if (err instanceof CatalogItemsUnknownError) {
        res.status(422).json({ success: false, error: 'Unknown or inactive catalog item(s)', code: err.code, details: { kind: err.kind, ids: err.ids } });
        return;
      }
      // Sem `details`: a URI é dado clínico — só o tipo do erro sai (T7 da terminologia).
      if (err instanceof DiagnosisUnknownError) {
        res.status(422).json({ success: false, error: 'Unknown diagnosis', code: err.code });
        return;
      }
      if (err instanceof TerminologyUnavailableError) {
        res.status(503).json({ success: false, error: err.message, code: 'TERMINOLOGY_UNAVAILABLE' });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTherapeuticProjectsController:create', patientId: params.data.id, mode: body.data.mode });
      res.status(500).json({ success: false, error: 'Failed to create therapeutic project version' });
    }
  }

  /** POST /patients/:id/therapeutic-projects/:vid/annul (lex C5) */
  async annul(req: Request, res: Response): Promise<void> {
    const params = versionParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = annulTherapeuticProjectSchema.safeParse(req.body);
    if (!body.success) {
      invalidBody(res, body.error);
      return;
    }
    try {
      const annulled = await this.repo.annul(params.data.id, params.data.vid, this.actorUid(req), body.data.reason);
      if (!annulled) {
        res.status(404).json({ success: false, error: 'Therapeutic project version not found or already annulled' });
        return;
      }
      res.status(200).json({ success: true, data: projectTherapeuticVersionForActor(annulled, cellsOfRequest(req)) });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTherapeuticProjectsController:annul', patientId: params.data.id, versionId: params.data.vid });
      res.status(500).json({ success: false, error: 'Failed to annul therapeutic project version' });
    }
  }

  // ── Catálogos ───────────────────────────────────────────────────────────────────────────

  /** GET /therapeutic-catalogs/<kind>?includeInactive=true — o `kind` vem da ROTA (célula literal), não de param. */
  async listCatalog(kind: TherapeuticCatalogKind, req: Request, res: Response): Promise<void> {
    try {
      const items = await this.catalogs.list(kind, { includeInactive: req.query.includeInactive === 'true' });
      res.status(200).json({ success: true, data: { kind, items } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTherapeuticProjectsController:listCatalog', kind });
      res.status(500).json({ success: false, error: 'Failed to list catalog' });
    }
  }

  /** POST /therapeutic-catalogs/<kind> — `segmentId` (430) só entra no corpo de objetivos/atividades (schema por `kind`). */
  async createCatalogItem(kind: TherapeuticCatalogKind, req: Request, res: Response): Promise<void> {
    const body = createCatalogItemSchemaFor(kind).safeParse(req.body);
    if (!body.success) {
      invalidBody(res, body.error);
      return;
    }
    try {
      const item = await this.catalogs.create(kind, { ...body.data, actorUid: this.actorUid(req) });
      res.status(201).json({ success: true, data: item });
    } catch (err: unknown) {
      if (err instanceof CatalogLabelTakenError) {
        res.status(409).json({ success: false, error: 'An active item with this label already exists', code: err.code });
        return;
      }
      // Segmento inexistente/inativo: 422 SEM ecoar o id (só o tipo do erro — molde de `DiagnosisUnknownError`).
      if (err instanceof CatalogSegmentInvalidError) {
        res.status(422).json({ success: false, error: 'Unknown or inactive segment', code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTherapeuticProjectsController:createCatalogItem', kind });
      res.status(500).json({ success: false, error: 'Failed to create catalog item' });
    }
  }

  /** PATCH /therapeutic-catalogs/<kind>/:itemId */
  async updateCatalogItem(kind: TherapeuticCatalogKind, req: Request, res: Response): Promise<void> {
    const params = catalogItemParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = updateCatalogItemSchemaFor(kind).safeParse(req.body);
    if (!body.success) {
      invalidBody(res, body.error);
      return;
    }
    try {
      const item = await this.catalogs.update(kind, params.data.itemId, { ...body.data, actorUid: this.actorUid(req) });
      if (!item) {
        res.status(404).json({ success: false, error: 'Catalog item not found' });
        return;
      }
      res.status(200).json({ success: true, data: item });
    } catch (err: unknown) {
      if (err instanceof CatalogLabelTakenError) {
        res.status(409).json({ success: false, error: 'An active item with this label already exists', code: err.code });
        return;
      }
      if (err instanceof CatalogSegmentInvalidError) {
        res.status(422).json({ success: false, error: 'Unknown or inactive segment', code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminTherapeuticProjectsController:updateCatalogItem', kind, itemId: params.data.itemId });
      res.status(500).json({ success: false, error: 'Failed to update catalog item' });
    }
  }
}
