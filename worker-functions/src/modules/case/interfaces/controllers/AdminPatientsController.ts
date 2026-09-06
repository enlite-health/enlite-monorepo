import { Request, Response } from 'express';
import { z } from 'zod';
import { Pool } from 'pg';
import { reportError, logger } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { adminPatientsListSchema } from '../validators/adminPatientsListSchema';
import { adminPatientParamsSchema } from '../validators/adminPatientParamsSchema';
import { createPatientSchema } from '../validators/createPatientSchema';
import { PatientQueryRepository } from '../../infrastructure/PatientQueryRepository';
import { GetPatientByIdUseCase } from '../../application/GetPatientByIdUseCase';
import { clinicalCellsOf, canReadPatientClinical, PATIENT_CLINICAL_READ_CELL } from '../../application/patientClinicalAccess';
import { patientContainerReadsOf } from '../../application/patientContainerAccess';
import { actorRolesOf } from '../../application/contractedServiceHourlyValueAccess';
import {
  toAdminPatientListItem,
  projectAdminPatientDetail,
  patientDetailCompleteness,
} from '../AdminPatientView';
import { GetPatientFunnelUseCase } from '../../application/GetPatientFunnelUseCase';
import { patientFunnelQuerySchema } from '../../application/patientFunnelSchema';
import {
  CreatePatientUseCase,
  PatientContactValidationError,
  type CreatePatientInput,
} from '../../application/CreatePatientUseCase';
import {
  ActivatePatientUseCase,
  PatientNotFoundError,
  PatientNotReadyError,
} from '../../application/ActivatePatientUseCase';
import {
  PatientService,
  type PatientGeneralSectionData,
  type PatientRelatedInput,
} from '../../application/PatientService';
import {
  PatientStatusTransitionError,
  OnHoldReasonRequiredError,
} from '../../application/PatientStatusWriter';
import { DeviceTypeUnknownError } from '../../infrastructure/PatientDeviceTypeRepository';
import { InsuranceProviderUnknownError } from '../../infrastructure/PatientInsuranceVerifiedRepository';
import { PatientDiagnosisService } from '@modules/diagnosis/application/PatientDiagnosisService';
import { PostgresPatientDiagnosisRepository } from '@modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository';
import { DiagnosisSource } from '@modules/diagnosis/domain/DiagnosisSource';
import { toDiagnosisPublicView } from '@modules/diagnosis/interfaces/DiagnosisPublicView';
import { createTerminologyPort } from '@modules/terminology/infrastructure/TerminologyPortFactory';
import { fetchPatientStatusHistory } from '../../infrastructure/PatientStatusHistoryQueryHelper';
import type { PatientStatus } from '../../domain/enums/PatientStatus';
import {
  SECTION_SCHEMAS,
  patientSectionParamSchema,
  patientStatusSchema,
} from '../validators/patientSectionSchemas';
import {
  PatientTestFixtureService,
  NotATestPatientError,
  TestVacancyHasApplicationsError,
} from '../../application/PatientTestFixtureService';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GeocodingService } from '../../../../infrastructure/services/GeocodingService';
import { fetchPatientVacancies } from '../../infrastructure/PatientVacanciesQueryHelper';
import { insertPatientAddress, fetchPatientAddresses } from '../../infrastructure/PatientAddressQueryHelper';

const createPatientAddressSchema = z.object({
  address_formatted: z.string().min(1),
  address_raw: z.string().optional(),
  address_type: z.enum(['primary', 'secondary', 'service']).default('secondary'),
  display_order: z.number().int().positive().optional(),
  // Spec 012, US-B2 (mig 316): logística por endereço. Zona = `neighborhood` (lex C2.7).
  neighborhood: z.string().trim().min(1).max(120).nullable().optional(),
  logistics_corridor: z.string().trim().min(1).max(200).nullable().optional(),
  // Texto livre sobre o domicílio — teto no servidor (lex C2.6), nunca em log/erro (C2.3).
  access_notes: z.string().trim().min(1).max(2000).nullable().optional(),
});

const patientIdSchema = z.object({
  patientId: z.string().uuid({ message: 'patientId must be a valid UUID' }),
});

/**
 * AdminPatientsController
 *
 * Endpoints:
 *   GET /api/admin/patients       — list with filters + pagination
 *   GET /api/admin/patients/stats — aggregate counters
 *   GET /api/admin/patients/:id   — full patient detail (read-only)
 *
 * No business logic here — delegates to use cases / repositories.
 * Auth is enforced at route level (requireStaff).
 */
export class AdminPatientsController {
  private readonly repo: PatientQueryRepository;
  private readonly getPatientByIdUseCase: GetPatientByIdUseCase;
  private readonly getPatientFunnelUseCase: GetPatientFunnelUseCase;
  private readonly createPatientUseCase: CreatePatientUseCase;
  private readonly activatePatientUseCase: ActivatePatientUseCase;
  private readonly patientService: PatientService;
  private readonly testFixtures: PatientTestFixtureService;
  private readonly db: Pool;
  private readonly geocoder: GeocodingService;
  /**
   * Spec 016 F2 (D263): "GET /patients/:id embute diagnoses[] na mesma projeção (sem code)".
   * Escopado a PANEL — mesma decisão de desenho do AdminPatientDiagnosesController (o painel
   * não é o escritor do ClickUp; a leitura em si, via listForPatient, é global entre origens).
   *
   * 🔧 C7 (QA-caça, correções F2): NÃO construído no construtor. `createTerminologyPort` lança
   * SÍNCRONO quando `TERMINOLOGY_ADAPTER` é inválido (typo no env) — construí-lo aqui derrubava
   * `new AdminPatientsController()` no boot (`index.ts`), o que derruba a API DE PACIENTES
   * INTEIRA por causa de uma env var que só a busca de diagnóstico usa. `getDiagnosisService()`
   * constrói SOB DEMANDA, dentro do mesmo try/catch do bulkhead (C4) — um env inválido vira
   * `diagnosesUnavailable: true`, nunca um processo que não sobe.
   */
  private readonly diagnosisServiceOverride: PatientDiagnosisService | undefined;
  private diagnosisServiceMemo: PatientDiagnosisService | undefined;

  constructor(
    geocoder?: GeocodingService,
    createPatientUseCase?: CreatePatientUseCase,
    patientService?: PatientService,
    activatePatientUseCase?: ActivatePatientUseCase,
    diagnosisService?: PatientDiagnosisService,
  ) {
    this.repo = new PatientQueryRepository();
    this.getPatientByIdUseCase = new GetPatientByIdUseCase(this.repo);
    this.db = DatabaseConnection.getInstance().getPool();
    this.getPatientFunnelUseCase = new GetPatientFunnelUseCase(this.db);
    this.createPatientUseCase = createPatientUseCase ?? new CreatePatientUseCase();
    this.patientService = patientService ?? new PatientService();
    this.activatePatientUseCase = activatePatientUseCase ?? new ActivatePatientUseCase();
    this.geocoder = geocoder ?? new GeocodingService();
    this.testFixtures = new PatientTestFixtureService(this.db);
    this.diagnosisServiceOverride = diagnosisService;
  }

  /** C7 — ver COMMENT do campo acima. Lança se `TERMINOLOGY_ADAPTER` for inválido; o chamador
   * (dentro do try/catch da leitura de diagnósticos) converte isso em `diagnosesUnavailable`. */
  private getDiagnosisService(): PatientDiagnosisService {
    if (this.diagnosisServiceOverride) return this.diagnosisServiceOverride;
    this.diagnosisServiceMemo ??= new PatientDiagnosisService(
      createTerminologyPort(process.env),
      new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL),
    );
    return this.diagnosisServiceMemo;
  }

  /**
   * PATCH /api/admin/patients/:id/test-flag   body: { isTest: boolean }
   *
   * Marca um paciente como sintético (synthetic monitoring). Espelha
   * `PATCH /api/admin/workers/:id/test-flag`. admin-only na rota.
   */
  async updatePatientTestFlag(req: Request, res: Response): Promise<void> {
    const paramsResult = patientIdSchema.safeParse({ patientId: req.params.id });
    if (!paramsResult.success) {
      res.status(400).json({ success: false, error: 'Invalid patient id' });
      return;
    }
    const bodyResult = z.object({ isTest: z.boolean() }).safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: bodyResult.error.flatten(),
      });
      return;
    }

    try {
      const isTest = await this.testFixtures.setTestFlag(
        paramsResult.data.patientId,
        bodyResult.data.isTest,
      );
      if (isTest === null) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      res.status(200).json({ success: true, data: { isTest } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:updatePatientTestFlag' });
      res.status(500).json({ success: false, error: 'Failed to update test flag' });
    }
  }

  /**
   * DELETE /api/admin/patients/:id — purga um paciente SINTÉTICO.
   *
   * Só age sobre `is_test = true`; paciente real devolve **409**, nunca apaga.
   * Limpa junto o evento do Google Calendar, a entrevista e as vagas geradas —
   * é o teardown da jornada diária do synthetic monitoring.
   */
  async purgeTestPatient(req: Request, res: Response): Promise<void> {
    const paramsResult = patientIdSchema.safeParse({ patientId: req.params.id });
    if (!paramsResult.success) {
      res.status(400).json({ success: false, error: 'Invalid patient id' });
      return;
    }

    try {
      // C2 — o ator vai para o log da eliminação: sem a linha no banco, ele é a
      // única evidência de quem apagou.
      const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id ?? null;
      const result = await this.testFixtures.purge(paramsResult.data.patientId, actorUid);
      if (result === null) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      if (err instanceof NotATestPatientError) {
        res.status(409).json({ success: false, error: err.message, code: err.code });
        return;
      }
      // C3 — a vaga sintética tem candidatura de prestador real: 409, não 500.
      // A limpeza não pode custar o dado de quem se candidatou de verdade.
      if (err instanceof TestVacancyHasApplicationsError) {
        res.status(409).json({
          success: false,
          error: err.message,
          code: err.code,
          applications: err.applications,
        });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:purgeTestPatient' });
      res.status(500).json({ success: false, error: 'Failed to purge test patient' });
    }
  }

  /**
   * PATCH /api/admin/patients/:id/:section
   *   section ∈ general | clinical | support-network | service
   *
   * Section-scoped partial update. The section decides the whitelist (a
   * per-section zod schema); an unknown section or an unknown field is a 400.
   * 404 when the patient does not exist. Delegates the write to
   * PatientService.updatePatientSection.
   */
  async updatePatientSection(req: Request, res: Response): Promise<void> {
    const paramsResult = patientSectionParamSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: paramsResult.error.flatten(),
      });
      return;
    }

    const { id, section } = paramsResult.data;
    const bodyResult = SECTION_SCHEMAS[section].safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: bodyResult.error.flatten(),
      });
      return;
    }

    // Ponto ÚNICO (D211.2, lex C1): quem não pode LER o texto clínico restrito também não o escreve.
    if ('emergencyInstructions' in (bodyResult.data as Record<string, unknown>) && !canReadPatientClinical(clinicalCellsOf(req))) {
      res.status(403).json({ success: false, error: 'Forbidden', details: { field: 'emergencyInstructions', cell: PATIENT_CLINICAL_READ_CELL } });
      return;
    }
    // lex C3.4 (spec 012): trilha de escrita do nº de afiliado SEM valor — uid, paciente, seção.
    if ('affiliateId' in (bodyResult.data as Record<string, unknown>)) {
      logger.info({ msg: 'patient_affiliate_id.write', uid: AuthMiddleware.getAuthContext(req)?.principal.id ?? null, patientId: id, section });
    }

    try {
      const exists = await this.db.query('SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (exists.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }

      // Autoria (REQ-01): o uid do staff vai para a mesma transação do PATCH.
      const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
      await this.patientService.updatePatientSection(
        id,
        section,
        bodyResult.data as PatientGeneralSectionData | PatientRelatedInput,
        actorUid ? { uid: actorUid } : undefined,
      );
      res.status(200).json({ success: true, data: { id } });
    } catch (err: unknown) {
      // Código fora do catálogo (device_types / insurance_providers): erro do cliente, não do servidor.
      if (err instanceof DeviceTypeUnknownError || err instanceof InsuranceProviderUnknownError) {
        res.status(422).json({ success: false, error: err.message, code: err.code, details: { codes: err.codes } });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:updatePatientSection', section });
      res.status(500).json({
        success: false,
        error: 'Failed to update patient section',
        details: e.message,
      });
    }
  }

  /**
   * PUT /api/admin/patients/:id/status — Kanban (funil) e select da ficha (estado clínico v2).
   * Body: { status, onHoldReason?, onHoldNote?, changeSource? }. Fora do vocabulário → 400;
   * transição fora de patient_status_transitions ou ON_HOLD sem motivo → 422 com código de enum;
   * `onHoldNote` só escreve quem pode LER texto clínico restrito (ponto único, D211.2) → 403.
   */
  async updatePatientStatus(req: Request, res: Response): Promise<void> {
    const paramsResult = adminPatientParamsSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: paramsResult.error.flatten(),
      });
      return;
    }

    const bodyResult = patientStatusSchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid status',
        details: bodyResult.error.flatten(),
      });
      return;
    }

    const { id } = paramsResult.data;
    const { status, onHoldReason, onHoldNote, changeSource } = bodyResult.data;

    // A guarda dispara pela CHAVE PRESENTE, não pelo valor não-nulo: `onHoldNote: null` é
    // ESCRITA (apaga a nota) e a `patient_status_history` não guarda segunda cópia — barrar só
    // o valor não-nulo barrava quem escreve e liberava quem APAGA (F5/B7, perda irrecuperável).
    const onHoldNoteInBody =
      typeof req.body === 'object' && req.body !== null &&
      Object.prototype.hasOwnProperty.call(req.body, 'onHoldNote');
    if (onHoldNoteInBody && !canReadPatientClinical(clinicalCellsOf(req))) {
      res.status(403).json({ success: false, error: 'Forbidden', details: { field: 'onHoldNote', cell: PATIENT_CLINICAL_READ_CELL } });
      return;
    }

    try {
      const result = await this.patientService.moveStatus(id, status as PatientStatus, {
        // Chave ausente → `undefined` → o serviço NÃO toca a coluna (ver MoveStatusOptions).
        onHoldNote: onHoldNoteInBody ? (onHoldNote ?? null) : undefined,
        onHoldReason: (onHoldReason ?? null) as import('../../domain/enums/OnHoldReason').OnHoldReason | null,
        changeSource: changeSource ?? 'admin_panel',
      });
      res.status(200).json({ success: true, data: { id: result.id, status: result.status } });
    } catch (err: unknown) {
      if (err instanceof PatientStatusTransitionError) {
        res.status(422).json({ success: false, error: err.message, code: err.code, details: { from: err.from, to: err.to } });
        return;
      }
      if (err instanceof OnHoldReasonRequiredError) {
        res.status(422).json({ success: false, error: err.message, code: err.code });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      if (/not found/i.test(e.message)) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      reportError(e, { source: 'AdminPatientsController:updatePatientStatus' });
      res.status(500).json({
        success: false,
        error: 'Failed to update patient status',
        details: e.message,
      });
    }
  }

  /**
   * GET /api/admin/patients/:id/status-history — a aba Historial (spec 012, US-B7).
   * Quando / de → para / origem. SEM ator (lex C7.2) e SEM `on_hold_note` (C7.3): a tabela
   * (254) não os tem, de propósito.
   */
  async getPatientStatusHistory(req: Request, res: Response): Promise<void> {
    const parsed = adminPatientParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid params', details: parsed.error.flatten() });
      return;
    }
    try {
      const exists = await this.db.query('SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL', [parsed.data.id]);
      if (exists.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      const history = await fetchPatientStatusHistory(this.db, parsed.data.id);
      res.status(200).json({ success: true, data: { history } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:getPatientStatusHistory' });
      res.status(500).json({ success: false, error: 'Failed to get patient status history' });
    }
  }

  /**
   * POST /api/admin/patients/:id/activate
   *
   * Approves the patient and opens recruitment: creates ONE draft vacancy per
   * active location (decisão D5) and moves the patient to ACTIVE. Idempotent —
   * an already-ACTIVE patient returns 200 with createdVacancyIds:[] (no dup).
   *   - 404 when the patient does not exist.
   *   - 422 when the patient has no active address (cannot activate without a
   *     location — nothing to create).
   */
  async activatePatient(req: Request, res: Response): Promise<void> {
    const parsed = adminPatientParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await this.activatePatientUseCase.execute(parsed.data.id);
      res.status(200).json({
        success: true,
        data: {
          patientId: result.patientId,
          status: result.status,
          createdVacancyIds: result.createdVacancyIds,
        },
      });
    } catch (err: unknown) {
      if (err instanceof PatientNotFoundError) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      if (err instanceof PatientNotReadyError) {
        // Spec 014 US-D1: mesmos códigos do checklist (`completeness.missing`), para o front
        // traduzir com o MESMO i18n em vez de repetir a frase crua do backend.
        res.status(422).json({
          success: false,
          error: err.message,
          code: 'PATIENT_NOT_READY',
          details: { missing: err.missing },
        });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:activatePatient' });
      res.status(500).json({
        success: false,
        error: 'Failed to activate patient',
        details: e.message,
      });
    }
  }

  /**
   * POST /api/admin/patients — manual creation of a native patient by the
   * admission team (Fase 1 Task 2). Born origin='admin_manual', status
   * ADMISSION. The contact-channel invariant is enforced by the use-case and
   * surfaced here as a 400 (client problem), never a 500.
   */
  async createPatient(req: Request, res: Response): Promise<void> {
    const parsed = createPatientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const { id } = await this.createPatientUseCase.execute(parsed.data as CreatePatientInput);
      res.status(201).json({ success: true, data: { id } });
    } catch (err: unknown) {
      if (err instanceof PatientContactValidationError) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:createPatient' });
      res.status(500).json({
        success: false,
        error: 'Failed to create patient',
        details: e.message,
      });
    }
  }

  /** GET /api/admin/patients */
  async listPatients(req: Request, res: Response): Promise<void> {
    const parsed = adminPatientsListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      // D286: as células do ator decidem o que a lista carrega — e o que o KMS descriptografa.
      const cells = clinicalCellsOf(req);
      const { rows, total } = await this.repo.list(parsed.data, patientContainerReadsOf(cells));

      const data = rows.map((row) => toAdminPatientListItem(row, cells));

      // Trilha de LEITURA de contato (lex 30/08 C5, molde OP-08/OP-11-D225):
      // quem leu, de que país, quantos e QUAIS pacientes. Nunca o e-mail — nem
      // mascarado. Sem contato exposto não há linha (minimização).
      const contactRows = data.filter((d) => d.leadContactEmailMasked != null);
      if (contactRows.length > 0) {
        logger.info({
          msg: 'patient_lead_contact.read',
          uid: AuthMiddleware.getAuthContext(req)?.principal.id ?? null,
          country: parsed.data.country ?? null,
          n: contactRows.length,
          patientIds: contactRows.map((d) => d.id),
        });
      }

      res.status(200).json({ success: true, data, total });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:listPatients' });
      res.status(500).json({
        success: false,
        error: 'Failed to list patients',
        details: e.message,
      });
    }
  }

  /** GET /api/admin/patients/:id — full patient detail */
  async getPatientById(req: Request, res: Response): Promise<void> {
    const parsed = adminPatientParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      // D286 / lex P3: a célula decide ANTES do KMS — o use case só descriptografa o que o ator lê.
      const cells = clinicalCellsOf(req);
      const result = await this.getPatientByIdUseCase.execute(parsed.data.id, patientContainerReadsOf(cells));

      if (!result.found) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }

      // Ponto ÚNICO de leitura do texto clínico restrito (D211.2) e do `hourlyValue` (lex
      // C-c.4): as duas redações vivem em `AdminPatientView.projectAdminPatientDetail`.
      const roles = actorRolesOf(req);
      const projected = projectAdminPatientDetail(result.patient as unknown as Record<string, unknown>, cells, roles);
      // Trilha de LEITURA sem valor (lex 29/08 C3, molde OP-08): uid, paciente, país, decisão, quando.
      // Nunca o texto, nunca o nome. Request redigida não gera linha (minimização).
      if (canReadPatientClinical(cells)) {
        logger.info({ msg: 'patient_clinical.read', uid: AuthMiddleware.getAuthContext(req)?.principal.id ?? null, patientId: parsed.data.id, country: (result.patient as { country?: string | null }).country ?? null, decision: 'allowed' });
      }
      // D286 / lex D-C8: UMA linha por abertura de ficha com o CONJUNTO de containers servidos —
      // é a linha em `resource_access_log` que o `logResourceAccess('patient', …)` da rota grava
      // (`action = read_detail:identity+clinical+…`), em tabela auditada. Não vai para o Cloud
      // Logging: uid×paciente em log publica o vínculo que a trilha existe para guardar (`lex` P7).

      const completeness = patientDetailCompleteness(result.patient, cells);

      // Spec 016 F2 (D263): diagnóstico estruturado embutido na MESMA projeção — REQ-21, sem
      // concept_code/concept_group/catalog_release (toDiagnosisPublicView é o único ponto que
      // decide o formato público). Bulkhead deliberado: uma falha aqui (ex.: catálogo de
      // terminologia fora do ar, OU `TERMINOLOGY_ADAPTER` mal configurado — C7) NUNCA derruba a
      // ficha inteira — o resto do detalhe do paciente já é útil sozinho.
      //
      // 🔧 C4 (QA-caça, correções F2): `[]` sozinho é indistinguível de "paciente sem
      // diagnóstico" — a operadora via card vazio num paciente que TEM diagnóstico, e o log da
      // falha vai só para o Cloud Logging (canal que ela não lê). Mesmo padrão já usado nesta
      // MESMA resposta (`emergencyInstructionsRedacted`, `hourlyValueRedacted`):
      // `diagnosesUnavailable` diz qual dos dois `[]` é. A falha continua reportada
      // (reportError), nunca silenciosa de verdade — `diagnosesUnavailable` é o que a TORNA
      // visível também para quem lê a tela, não só para quem lê o Cloud Logging.
      let diagnoses: ReturnType<typeof toDiagnosisPublicView>[] | null = [];
      let diagnosesUnavailable = false;
      try {
        // D286: diagnóstico CID-11 é container clínico — sem `patient_clinical:read` não se busca
        // (nem se devolve `[]`, que diria "sem diagnóstico"): sai `null`, com `redacted.clinical`.
        if (!patientContainerReadsOf(cells).clinical) {
          diagnoses = null;
        } else {
          const diagnosesResult = await this.getDiagnosisService().listForPatient(parsed.data.id);
          diagnoses = diagnosesResult.found ? diagnosesResult.diagnoses.map(toDiagnosisPublicView) : [];
        }
      } catch (diagErr: unknown) {
        const de = diagErr instanceof Error ? diagErr : new Error(String(diagErr));
        reportError(de, { source: 'AdminPatientsController:getPatientById:diagnoses', patientId: parsed.data.id });
        diagnosesUnavailable = true;
      }

      res.status(200).json({ success: true, data: { ...projected, diagnoses, diagnosesUnavailable, completeness } });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:getPatientById' });
      res.status(500).json({
        success: false,
        error: 'Failed to get patient details',
        details: e.message,
      });
    }
  }

  /** POST /api/admin/patients/:patientId/addresses */
  async createPatientAddress(req: Request, res: Response): Promise<void> {
    const paramsResult = patientIdSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: paramsResult.error.flatten(),
      });
      return;
    }

    const bodyResult = createPatientAddressSchema.safeParse(req.body);
    if (!bodyResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid body',
        details: bodyResult.error.flatten(),
      });
      return;
    }

    const { patientId } = paramsResult.data;
    const { address_formatted, address_raw, address_type, display_order, neighborhood, logistics_corridor, access_notes } = bodyResult.data;

    try {
      const created = await insertPatientAddress(this.db, this.geocoder, {
        patientId,
        addressFormatted:   address_formatted,
        addressRaw:         address_raw ?? null,
        addressType:        address_type,
        displayOrder:       display_order ?? null,
        neighborhood:       neighborhood ?? null,
        logisticsCorridor:  logistics_corridor ?? null,
        accessNotes:        access_notes ?? null,
      });

      // Trilha SEM valor (lex C2.3): quem, paciente, e o TAMANHO do que foi gravado.
      logger.info({
        msg: 'patient_address.created',
        uid: AuthMiddleware.getAuthContext(req)?.principal.id ?? null,
        patientId,
        addressId: created.id,
        accessNotesLen: (access_notes ?? '').length,
        logisticsCorridorLen: (logistics_corridor ?? '').length,
      });
      res.status(201).json({ success: true, data: created });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      // lex C2.3: nada do corpo na resposta — um erro do Postgres pode ecoar a linha inteira.
      reportError(e, { source: 'AdminPatientsController:createPatientAddress', patientId });
      res.status(500).json({
        success: false,
        error: 'Failed to create patient address',
      });
    }
  }

  /** GET /api/admin/patients/:patientId/addresses */
  async listPatientAddresses(req: Request, res: Response): Promise<void> {
    const paramsResult = patientIdSchema.safeParse(req.params);
    if (!paramsResult.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: paramsResult.error.flatten(),
      });
      return;
    }

    const { patientId } = paramsResult.data;

    try {
      const rows = await fetchPatientAddresses(this.db, patientId);
      res.status(200).json({ success: true, data: rows });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:listPatientAddresses' });
      res.status(500).json({
        success: false,
        error: 'Failed to list patient addresses',
        details: e.message,
      });
    }
  }

  /** GET /api/admin/patients/stats?country=AR|BR */
  async getPatientStats(req: Request, res: Response): Promise<void> {
    try {
      const country = req.query.country === 'AR' || req.query.country === 'BR'
        ? req.query.country
        : undefined;
      const stats = await this.repo.stats(country);
      res.status(200).json({ success: true, data: stats });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:getPatientStats' });
      res.status(500).json({
        success: false,
        error: 'Failed to get patient stats',
        details: e.message,
      });
    }
  }

  /**
   * GET /api/admin/patients/funnel?country=AR|BR&from=ISO&to=ISO
   *
   * Conversão do funil de pacientes por país e período (Fase 4). Sem from/to,
   * usa os últimos 30 dias. Controller fino — delega ao GetPatientFunnelUseCase.
   */
  async getPatientFunnel(req: Request, res: Response): Promise<void> {
    const parsed = patientFunnelQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid query params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const data = await this.getPatientFunnelUseCase.execute(parsed.data);
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:getPatientFunnel' });
      res.status(500).json({
        success: false,
        error: 'Failed to get patient funnel',
        details: e.message,
      });
    }
  }

  /**
   * GET /api/admin/patients/:id/vacancies
   *
   * Lists all non-deleted job_postings for a patient, ordered newest first.
   * Returns all vagas regardless of is_draft or status so the operator has
   * the complete history in one call.
   */
  async listPatientVacancies(req: Request, res: Response): Promise<void> {
    const parsed = adminPatientParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid params',
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const vacancies = await fetchPatientVacancies(this.db, parsed.data.id);
      res.status(200).json({ success: true, data: vacancies });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPatientsController:listPatientVacancies' });
      res.status(500).json({
        success: false,
        error: 'Failed to list patient vacancies',
        details: e.message,
      });
    }
  }
}
