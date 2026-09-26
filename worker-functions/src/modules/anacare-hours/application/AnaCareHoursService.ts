/**
 * src/modules/anacare-hours/application/AnaCareHoursService.ts
 *
 * Orquestra a porta `AnaCareShiftsSource` (adapter falso em F1) + `ShiftHoursValidationRepository`
 * + KMS (nota de contestação) para servir os 6 métodos do contrato do protótipo: getMonthSnapshot,
 * getPatientMonth, getRetratoStatus, validateShift, validateBatch, contestShift. Nenhum
 * `reportError`/`logger` abaixo carrega nome, ID de paciente/prestador nem texto de nota — regra
 * dura CLAUDE.md (texto clínico nunca em log).
 */

import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type { AnaCareShiftsSource, SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import type { PatientMonthSyncRepository, SyncRunRepository } from '../domain/AnaCareHoursSyncPorts';
import { AnaCarePatientDocumentRepository, AxonicoLancamentoRepository, type IAnaCarePatientDocumentRepository, type IAxonicoLancamentoRepository } from '@modules/integration';
import { ShiftHoursValidationRepository, ShiftAlreadyValidatedError } from '../infrastructure/ShiftHoursValidationRepository';
import { WorkerLinkRepository } from '../infrastructure/WorkerLinkRepository';
import { AnaCarePatientMonthRepository } from '../infrastructure/AnaCarePatientMonthRepository';
import { AnaCareSyncRunRepository } from '../infrastructure/AnaCareSyncRunRepository';
import { mapShift, groupIntoPatients, buildSnapshot, computeActualHours, joinSourceName, attachAxonicoToPatient, resolveDocumentNumberForAxonico, AXONICO_SERVICE_TYPE } from './AnaCareHoursMapper';
import {
  AnaCareHoursServiceError,
  CONTEST_NOTE_MAX_LENGTH,
  VALIDATE_BATCH_MAX_SHIFTS,
  type AnaCareListPatient,
  type AnaCareListProvider,
  type AnaCareMonthSnapshot,
  type AnaCarePatient,
  type AnaCareRetratoStatus,
  type ContestReason,
} from '../domain/AnaCareShift';

/** Única fonte hoje (mesma convenção do repositório: constante interna, não parâmetro do chamador). */
const PATIENT_MONTH_SOURCE = 'anacare';

export interface ValidateBatchItemResult {
  shiftId: string;
  ok: boolean;
  code?: string;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(month: string): boolean {
  return MONTH_RE.test(month);
}

export function periodMonthDate(month: string): string {
  return `${month}-01`;
}

export class AnaCareHoursService {
  constructor(
    private readonly source: AnaCareShiftsSource,
    private readonly validations: ShiftHoursValidationRepository = new ShiftHoursValidationRepository(),
    private readonly kms: KMSEncryptionService = new KMSEncryptionService(),
    private readonly workerLinks: WorkerLinkRepository = new WorkerLinkRepository(),
    /**
     * F6.2 (D361/Adendo 17/09): retrato AGREGADO por paciente+mês (`anacare_patient_month` +
     * `anacare_patient_month_provider`, migrations 441/442) — a LISTA (`getMonthSnapshot`) lê
     * exclusivamente daqui, nunca mais do array de turnos.
     */
    private readonly patientMonthRepository: PatientMonthSyncRepository = new AnaCarePatientMonthRepository(),
    /**
     * Fallback do documento do paciente (item 5, 19/09/2026, migration 446): quando a FONTE (Ana
     * Care) não manda `patientDocumentType`/`patientDocumentNumber` para um turno, `buildPatients`
     * consulta aqui pelo documento que o operador registrou manualmente
     * (`RegistrarDocumentoPacienteAnaCareUseCase`). Mesmo gate `patient_identity:read` que já
     * existia (`canReadPatientDocument`) — o documento registrado é PII igual ao original, o gate
     * não relaxa.
     */
    private readonly patientDocuments: IAnaCarePatientDocumentRepository = new AnaCarePatientDocumentRepository(),
    /**
     * F2 (change `anacare-horas-conclusao-de-corrida`, migration 457): conclusão da corrida de
     * sync (`status`/`reservations_total`/`reservations_done`) — só usada por `getMonthSnapshot`,
     * pra decidir `parcial`/`desconhecido` (`AnaCareHoursMapper.computeSnapshotState`). Parâmetro
     * NOVO no fim da lista (nunca no meio) — nenhum chamador existente que já passa até
     * `patientDocuments` precisa mudar.
     */
    private readonly syncRunRepository: SyncRunRepository = new AnaCareSyncRunRepository(),
    private readonly lancamentoRepository: IAxonicoLancamentoRepository = new AxonicoLancamentoRepository(),
  ) {}

  /**
   * D349 item 1: resolve o VÍNCULO de prestador em LOTE (nunca 1 SELECT por turno) — só decide
   * `linked` (presença do `anaCareNurseId` em `workers.ana_care_id`). Item 1 da conferência de
   * horas (decisão do Gabriel 17/09) tirou o NOME daqui: nome não vem mais do cruzamento com
   * `workers` (não decifra mais `firstNameEncrypted`/`lastNameEncrypted`), vem do payload da
   * FONTE — ver `joinSourceName` em `buildPatients`. `linked` continua útil por si (D349): diz que
   * o prestador do turno casa com um worker nosso, independente de termos o nome dele.
   */
  private async resolveLinkedNurseIds(nurseIds: readonly string[]): Promise<ReadonlySet<string>> {
    const rows = await this.workerLinks.findByAnaCareIds(nurseIds);
    return new Set(rows.keys());
  }

  /**
   * Comum aos dois caminhos (lista/detalhe): junta turnos JÁ OBTIDOS (do banco OU ao vivo) com
   * validação + vínculo de prestador + decifra de nota. Quem decide DE ONDE vieram os
   * `sourceShifts` é o chamador (`getMonthSnapshot` lê do retrato; `getPatientMonth` vai à fonte).
   *
   * Nome (item 1, 17/09): paciente sempre que a fonte mandar; prestador só quando
   * `canReadProviderName` — MESMO gate de `worker_contact:read` de antes, só a ORIGEM do valor
   * mudou (payload do turno, não mais `workers` decifrado).
   *
   * Documento do paciente (item 4, 18/09): mesmo desenho de `canReadProviderName`, mas o gate é
   * `patient_identity:read` (célula do container "Identidade" da ficha, `patientContainerAccess.
   * ts`) — sem ela o campo vem AUSENTE, nunca vazio/redigido.
   */
  private async buildPatients(
    sourceShifts: readonly SourceShiftDTO[],
    canReadNote: boolean,
    canReadProviderName: boolean,
    canReadPatientDocument = false,
  ): Promise<AnaCarePatient[]> {
    const validations = await this.validations.getByShiftIds(sourceShifts.map((s) => s.sourceShiftId));
    const nurseIds = [...new Set(sourceShifts.map((s) => s.anaCareNurseId))];
    const linkedNurseIds = await this.resolveLinkedNurseIds(nurseIds);

    // Fallback (item 5, migration 446): só busca o documento REGISTRADO para os pacientes cujo
    // turno NÃO trouxe documento da fonte — nunca substitui o que a fonte já mandou. Lookup em
    // LOTE por `anaCarePatientId` distinto (mesmo desenho de `resolveLinkedNurseIds`), nunca 1
    // SELECT por turno.
    const registeredDocuments = canReadPatientDocument
      ? await this.resolveRegisteredDocuments(sourceShifts)
      : new Map<string, { documentType: string | null; documentNumber: string }>();

    const mapped = await Promise.all(
      sourceShifts.map(async (s) => {
        const validation = validations.get(s.sourceShiftId);
        const decryptedNote = canReadNote && validation?.noteEncrypted ? await this.kms.decrypt(validation.noteEncrypted) : null;
        const shift = mapShift(s, validation, canReadNote, decryptedNote || null);
        const patientName = joinSourceName(s.patientFirstName, s.patientLastName);
        const nurseName = canReadProviderName ? joinSourceName(s.nurseFirstName, s.nurseLastName) : undefined;
        const registered = registeredDocuments.get(s.anaCarePatientId);
        const patientDocumentType = canReadPatientDocument
          ? s.patientDocumentType ?? registered?.documentType ?? undefined
          : undefined;
        const patientDocumentNumber = canReadPatientDocument
          ? s.patientDocumentNumber ?? registered?.documentNumber ?? undefined
          : undefined;
        return {
          shift,
          anaCarePatientId: s.anaCarePatientId,
          anaCareNurseId: s.anaCareNurseId,
          patientName,
          nurseName,
          patientDocumentType,
          patientDocumentNumber,
        };
      }),
    );

    return groupIntoPatients(mapped, linkedNurseIds);
  }

  /**
   * Busca em LOTE (`Promise.all`, uma chamada por paciente distinto — a porta não expõe
   * `findManyByPatientIds`, e o volume por tela é baixo, mesma ordem de grandeza de
   * `resolveLinkedNurseIds`) o documento REGISTRADO manualmente para os pacientes SEM documento na
   * fonte. Só entra no mapa quem tem registro — ausência de registro não gera entrada (o `?.`
   * no chamador cobre o `undefined`).
   */
  private async resolveRegisteredDocuments(
    sourceShifts: readonly SourceShiftDTO[],
  ): Promise<Map<string, { documentType: string | null; documentNumber: string }>> {
    const missingIds = [
      ...new Set(
        sourceShifts.filter((s) => !s.patientDocumentNumber).map((s) => s.anaCarePatientId),
      ),
    ];
    if (missingIds.length === 0) return new Map();

    const entries = await Promise.all(
      missingIds.map(async (id) => {
        const record = await this.patientDocuments.findByPatientId(id);
        return record ? ([id, { documentType: record.documentType, documentNumber: record.documentNumber }] as const) : null;
      }),
    );
    return new Map(entries.filter((e): e is readonly [string, { documentType: string | null; documentNumber: string }] => e !== null));
  }

  /**
   * F6.2 (D361/Adendo 17/09): a LISTA lê o retrato AGREGADO (`anacare_patient_month` +
   * `anacare_patient_month_provider`) — ZERO chamadas a `source.listShifts` e ZERO turnos
   * individuais na resposta (o contrato da rota não tem mais `shifts` em lugar nenhum). D4: sem
   * filtro de query — `patientSearch`/`providerId` rodam só no CLIENTE (`selectors.ts`), nunca aqui.
   *
   * A contagem de `validated`/`contested` deixa de nascer do join 1:1 por `source_shift_id` e passa
   * a vir do `GROUP BY` em `shift_hours_validation` (`ShiftHoursValidationRepository.getStatusCountsByMonth`)
   * — `canReadNote` não é mais usado aqui: a LISTA nunca expôs nota de contestação por turno
   * (campo que só existia dentro de `AnaCareShift`, removido do contrato da lista); o parâmetro
   * continua na assinatura por compat com o chamador (`AnaCareHoursController`).
   *
   * Contagem zero é falha, nunca sucesso: sem nenhuma linha gravada para o mês, o retrato AGREGADO
   * NUNCA foi construído (o sync real ainda não rodou) — isso NUNCA vira "lista vazia" silenciosa,
   * é SEMPRE reportado como desatualizado (`stale: true`), igual a uma queda do circuit breaker.
   */
  async getMonthSnapshot(month: string, _canReadNote: boolean, canReadProviderName = false): Promise<AnaCareMonthSnapshot> {
    const [aggregates, providerRows, validationCounts, freshness, sourceRetrato, syncConclusion] = await Promise.all([
      this.patientMonthRepository.listByMonth(PATIENT_MONTH_SOURCE, month),
      this.patientMonthRepository.listProvidersByMonth(PATIENT_MONTH_SOURCE, month),
      this.validations.getStatusCountsByMonth(periodMonthDate(month)),
      this.patientMonthRepository.getSnapshotFreshness(PATIENT_MONTH_SOURCE, month),
      this.source.getRetratoStatus(),
      // F2 (migration 457): conclusão da corrida deste mês — alimenta `parcial`/`desconhecido`
      // em `buildSnapshot` (ver `computeSnapshotState`). Mesma fonte (`PATIENT_MONTH_SOURCE`)
      // usada por todo o resto do método.
      this.syncRunRepository.getConclusion(PATIENT_MONTH_SOURCE, month),
    ]);

    // Vínculo de prestador (D349 item 1) — mesmo lookup em LOTE que o DETALHE usa, agora sobre os
    // `anaCareNurseId` do PAR paciente×prestador (migration 442), não mais sobre turnos.
    const nurseIds = [...new Set(providerRows.map((p) => p.anaCareNurseId))];
    const linkedNurseIds = await this.resolveLinkedNurseIds(nurseIds);

    const providersByPatient = new Map<string, AnaCareListProvider[]>();
    for (const p of providerRows) {
      const list = providersByPatient.get(p.anaCarePatientId) ?? [];
      list.push({
        anaCareId: p.anaCareNurseId,
        linked: linkedNurseIds.has(p.anaCareNurseId),
        name: canReadProviderName ? joinSourceName(p.nurseFirstName, p.nurseLastName) : undefined,
      });
      providersByPatient.set(p.anaCarePatientId, list);
    }

    const patients: AnaCareListPatient[] = aggregates.map((a) => {
      const counts = validationCounts.get(a.anaCarePatientId);
      return {
        anaCareId: a.anaCarePatientId,
        name: joinSourceName(a.patientFirstName, a.patientLastName),
        linked: false, // D349 item 2 — paciente permanece sempre sem vínculo, bloqueado.
        providers: providersByPatient.get(a.anaCarePatientId) ?? [],
        providersCount: a.providersCount,
        shiftsCount: a.shiftsCount,
        hoursActualSum: a.hoursActualSum,
        hoursScheduledSumMissingActual: a.hoursScheduledSumMissingActual,
        validated: counts?.validated ?? 0,
        contested: counts?.contested ?? 0,
        originSinCheckin: a.originSinCheckin,
        originWebAdmin: a.originWebAdmin,
        originApp: a.originApp,
      };
    });

    const naoConstruido = freshness.shifts === 0;
    const snapshot = buildSnapshot(
      month,
      patients,
      {
        stale: naoConstruido || sourceRetrato.stale,
        circuitBreakerOpen: sourceRetrato.circuitBreakerOpen,
        naoConstruido,
      },
      syncConclusion,
    );
    return freshness.lastFetchedAt ? { ...snapshot, updatedAt: freshness.lastFetchedAt } : snapshot;
  }

  /** O DETALHE continua AO VIVO na fonte — é a passagem Tela→backend→Ana Care→backend→Tela, barata por reserva/paciente (medido 17/09). */
  async getPatientMonth(
    month: string,
    patientId: string,
    canReadNote: boolean,
    canReadProviderName = false,
    canReadPatientDocument = false,
  ): Promise<AnaCarePatient | null> {
    // `skipped` (turno sem paciente/prestador) não é reportado aqui — só o sync agrega e conta.
    const { shifts: sourceShifts } = await this.source.listShifts({ month, patientId });
    const patients = await this.buildPatients(sourceShifts, canReadNote, canReadProviderName, canReadPatientDocument);
    const patient = patients.find((p) => p.anaCareId === patientId) ?? null;
    if (patient) {
      // A2 (gate revisao-pr): chave do Axonico SEMPRE resolvida — nunca via `patient.documentNumber` (gated por `patient_identity:read`).
      const axonicoDocumentNumber = await resolveDocumentNumberForAxonico(sourceShifts, patientId, this.patientDocuments);
      if (axonicoDocumentNumber) {
        attachAxonicoToPatient(patient, await this.lancamentoRepository.findSentByDocumentAndMonth(axonicoDocumentNumber, AXONICO_SERVICE_TYPE, periodMonthDate(month)));
      }
    }
    return patient;
  }

  /**
   * Barato: só freshness do retrato + status da fonte — nunca lista nem mapeia o mês inteiro.
   *
   * Conserto 17/09 (passo 2): migrado do antigo repositório do retrato por turno (que ninguém mais
   * escrevia desde o passo 1 — reportaria data velha PARA SEMPRE, e foi apagado no passo 2) para
   * `patientMonthRepository.getSnapshotFreshness` (lê `anacare_patient_month`, escrito pelo
   * runner a cada corrida). ⚠️ Mudança de UNIDADE do `shifts` retornado: no repositório antigo
   * era `COUNT(*)` de TURNOS (medido ~2700); no novo é `COUNT(*)` de
   * `anacare_patient_month` = nº de LINHAS = nº de PACIENTES (medido ~145). O `naoConstruido`
   * (`=== 0`) se comporta igual nos dois casos (zero linhas ⇔ zero pacientes ⇔ zero turnos, mesma
   * condição de "nunca construído") — mas o NÚMERO em si mudou de grandeza. Grep feito (ver
   * relato do fecho): `getRetratoStatus` NÃO expõe `freshness.shifts` na resposta (só usa para o
   * booleano `naoConstruido` e descarta a contagem) — nenhum outro consumidor lê esse número como
   * quantidade de turnos.
   */
  async getRetratoStatus(month: string): Promise<AnaCareRetratoStatus> {
    const [freshness, sourceRetrato] = await Promise.all([
      this.patientMonthRepository.getSnapshotFreshness(PATIENT_MONTH_SOURCE, month),
      this.source.getRetratoStatus(),
    ]);
    const naoConstruido = freshness.shifts === 0;
    return {
      updatedAt: freshness.lastFetchedAt ?? new Date().toISOString(),
      stale: naoConstruido || sourceRetrato.stale,
      circuitBreakerOpen: sourceRetrato.circuitBreakerOpen,
    };
  }

  /** Busca o turno na FONTE (não no snapshot inteiro) — usado por validar/contestar (não recebem mês). */
  private async requireSourceShift(shiftId: string): ReturnType<AnaCareShiftsSource['getShift']> {
    const shift = await this.source.getShift(shiftId);
    if (!shift) throw new AnaCareHoursServiceError('TURNO_NAO_ENCONTRADO');
    return shift;
  }

  /**
   * Recusa a escrita quando o retrato está desatualizado — a MESMA regra que a tela aplica
   * (`selectors.ts` `blockReason`: `stale || circuitBreakerOpen`) e que o Fake do front já
   * simula (`AnaCareHoursService.ts` `assertRetratoOk` do enlite-frontend, "defesa em
   * profundidade, não substituição"). Spec `anacare-shift-hours`: "retrato desatualizado bloqueia
   * a validação no serviço e na tela" — cobre validar (individual e lote, via `validateShift`) e
   * contestar, os dois pontos de escrita da fase 1.
   */
  private async assertRetratoOk(): Promise<void> {
    const { stale, circuitBreakerOpen } = await this.source.getRetratoStatus();
    if (stale || circuitBreakerOpen) {
      throw new AnaCareHoursServiceError(
        'RETRATO_DESATUALIZADO',
        'Retrato desactualizado — ninguna acción de escritura es aceptada hasta el próximo retrato.',
      );
    }
  }

  async validateShift(shiftId: string, validatorUid: string): Promise<void> {
    await this.assertRetratoOk();
    const source = await this.requireSourceShift(shiftId);
    try {
      await this.validations.validate({
        sourceShiftId: source!.sourceShiftId,
        anaCarePatientId: source!.anaCarePatientId,
        anaCareNurseId: source!.anaCareNurseId,
        periodMonth: periodMonthDate(source!.date.slice(0, 7)),
        approvedHours: computeActualHours(source!) ?? 0, // D344: sem check-in (ou sem checkout) congela 0h — nunca o previsto
        approvedCheckinAt: source!.actualStart,
        approvedCheckoutAt: source!.actualEnd,
        approvedCheckinSource: source!.checkinSource,
        validatedBy: validatorUid,
      });
    } catch (err) {
      if (err instanceof ShiftAlreadyValidatedError) throw new AnaCareHoursServiceError('JA_VALIDADO');
      throw err;
    }
  }

  /**
   * Valida cada turno independentemente — um 409 isolado não derruba os demais (batch parcial).
   * `validateShift` já chama `assertRetratoOk()` por item — retrato desatualizado vira
   * `{ ok: false, code: 'RETRATO_DESATUALIZADO' }` em CADA item do lote, mesmo padrão do 409
   * isolado de `JA_VALIDADO` acima (não recusa o lote inteiro de uma vez, só cada escrita).
   */
  async validateBatch(shiftIds: readonly string[], validatorUid: string): Promise<ValidateBatchItemResult[]> {
    if (shiftIds.length > VALIDATE_BATCH_MAX_SHIFTS) {
      throw new AnaCareHoursServiceError('TURNO_NAO_ENCONTRADO', `lote acima do limite de ${VALIDATE_BATCH_MAX_SHIFTS}`);
    }
    const results: ValidateBatchItemResult[] = [];
    for (const shiftId of shiftIds) {
      try {
        await this.validateShift(shiftId, validatorUid);
        results.push({ shiftId, ok: true });
      } catch (err) {
        const code = err instanceof AnaCareHoursServiceError ? err.code : 'ERRO_DESCONHECIDO';
        results.push({ shiftId, ok: false, code });
      }
    }
    return results;
  }

  async contestShift(shiftId: string, reason: ContestReason, note: string | undefined): Promise<void> {
    if (note !== undefined && note.length > CONTEST_NOTE_MAX_LENGTH) {
      throw new AnaCareHoursServiceError('NOTA_MUITO_LONGA', `nota acima do limite de ${CONTEST_NOTE_MAX_LENGTH} caracteres`);
    }
    await this.assertRetratoOk();
    const source = await this.requireSourceShift(shiftId);
    const noteEncrypted = note ? await this.kms.encrypt(note) : null;
    try {
      await this.validations.contest({
        sourceShiftId: source!.sourceShiftId,
        anaCarePatientId: source!.anaCarePatientId,
        anaCareNurseId: source!.anaCareNurseId,
        periodMonth: periodMonthDate(source!.date.slice(0, 7)),
        reason,
        noteEncrypted,
      });
    } catch (err) {
      if (err instanceof ShiftAlreadyValidatedError) throw new AnaCareHoursServiceError('JA_VALIDADO');
      throw err;
    }
  }
}
