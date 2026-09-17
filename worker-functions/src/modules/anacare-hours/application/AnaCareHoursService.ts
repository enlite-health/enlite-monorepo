/**
 * src/modules/anacare-hours/application/AnaCareHoursService.ts
 *
 * Orquestra a porta `AnaCareShiftsSource` (adapter falso em F1) + `ShiftHoursValidationRepository`
 * + KMS (nota de contestação) para servir os 6 métodos do contrato do protótipo (spec §Contrato
 * de dados): getMonthSnapshot, getPatientMonth, getRetratoStatus, validateShift, validateBatch,
 * contestShift.
 *
 * Nenhum `reportError`/`logger` abaixo carrega nome, ID de paciente/prestador da Ana Care nem o
 * texto da nota — regra dura CLAUDE.md (texto clínico nunca em log).
 */

import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type { AnaCareShiftsSource, SourceShiftDTO } from '../domain/AnaCareShiftsSource';
import type { ShiftSyncRepository } from '../domain/AnaCareHoursSyncPorts';
import { ShiftHoursValidationRepository, ShiftAlreadyValidatedError } from '../infrastructure/ShiftHoursValidationRepository';
import { WorkerLinkRepository } from '../infrastructure/WorkerLinkRepository';
import { AnaCareShiftRepository } from '../infrastructure/AnaCareShiftRepository';
import { mapShift, groupIntoPatients, buildSnapshot, computeActualHours, joinSourceName } from './AnaCareHoursMapper';
import {
  AnaCareHoursServiceError,
  CONTEST_NOTE_MAX_LENGTH,
  VALIDATE_BATCH_MAX_SHIFTS,
  type AnaCareMonthSnapshot,
  type AnaCarePatient,
  type AnaCareRetratoStatus,
  type ContestReason,
} from '../domain/AnaCareShift';

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
    /** Retrato do mês (escrito pelo sync real) — a LISTA lê daqui, nunca da fonte. */
    private readonly shiftRepository: ShiftSyncRepository = new AnaCareShiftRepository(),
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
   */
  private async buildPatients(sourceShifts: readonly SourceShiftDTO[], canReadNote: boolean, canReadProviderName: boolean): Promise<AnaCarePatient[]> {
    const validations = await this.validations.getByShiftIds(sourceShifts.map((s) => s.sourceShiftId));
    const nurseIds = [...new Set(sourceShifts.map((s) => s.anaCareNurseId))];
    const linkedNurseIds = await this.resolveLinkedNurseIds(nurseIds);

    const mapped = await Promise.all(
      sourceShifts.map(async (s) => {
        const validation = validations.get(s.sourceShiftId);
        const decryptedNote = canReadNote && validation?.noteEncrypted ? await this.kms.decrypt(validation.noteEncrypted) : null;
        const shift = mapShift(s, validation, canReadNote, decryptedNote || null);
        const patientName = joinSourceName(s.patientFirstName, s.patientLastName);
        const nurseName = canReadProviderName ? joinSourceName(s.nurseFirstName, s.nurseLastName) : undefined;
        return { shift, anaCarePatientId: s.anaCarePatientId, anaCareNurseId: s.anaCareNurseId, patientName, nurseName };
      }),
    );

    return groupIntoPatients(mapped, linkedNurseIds);
  }

  /**
   * A LISTA lê do NOSSO banco (`ShiftSyncRepository.listByMonth`) — ZERO chamadas a
   * `source.listShifts` (spec §Assimetria lista×detalhe: a API não filtra por agência, varrer o
   * mês inteiro pagina 39 agências e estoura o teto do Cloud Run). D4: sem filtro de query —
   * `patientSearch`/`providerId` rodam só no CLIENTE (`selectors.ts`), nunca aqui.
   *
   * Contagem zero é falha, nunca sucesso: sem nenhuma linha gravada para o mês, o retrato NUNCA
   * foi construído (o sync real ainda não rodou) — isso NUNCA vira "lista vazia" silenciosa, é
   * SEMPRE reportado como desatualizado (`stale: true`), igual a uma queda do circuit breaker.
   */
  async getMonthSnapshot(month: string, canReadNote: boolean, canReadProviderName = false): Promise<AnaCareMonthSnapshot> {
    const [sourceShifts, freshness, sourceRetrato] = await Promise.all([
      this.shiftRepository.listByMonth(month),
      this.shiftRepository.getSnapshotFreshness(month),
      this.source.getRetratoStatus(),
    ]);
    const patients = await this.buildPatients(sourceShifts, canReadNote, canReadProviderName);
    const naoConstruido = freshness.shifts === 0;
    const snapshot = buildSnapshot(month, patients, {
      stale: naoConstruido || sourceRetrato.stale,
      circuitBreakerOpen: sourceRetrato.circuitBreakerOpen,
      naoConstruido,
    });
    return freshness.lastFetchedAt ? { ...snapshot, updatedAt: freshness.lastFetchedAt } : snapshot;
  }

  /** O DETALHE continua AO VIVO na fonte — é a passagem Tela→backend→Ana Care→backend→Tela, barata por reserva/paciente (medido 17/09). */
  async getPatientMonth(month: string, patientId: string, canReadNote: boolean, canReadProviderName = false): Promise<AnaCarePatient | null> {
    // `skipped` (turno sem paciente/prestador) não é reportado por este caminho de DETALHE —
    // só o sync (`AnaCareHoursSyncRunner`) agrega e conta; achado registrado em separado.
    const { shifts: sourceShifts } = await this.source.listShifts({ month, patientId });
    const patients = await this.buildPatients(sourceShifts, canReadNote, canReadProviderName);
    return patients.find((p) => p.anaCareId === patientId) ?? null;
  }

  /** Barato: só freshness do retrato + status da fonte — nunca lista nem mapeia o mês inteiro. */
  async getRetratoStatus(month: string): Promise<AnaCareRetratoStatus> {
    const [freshness, sourceRetrato] = await Promise.all([this.shiftRepository.getSnapshotFreshness(month), this.source.getRetratoStatus()]);
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
