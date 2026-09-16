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
import type { AnaCareShiftsSource } from '../domain/AnaCareShiftsSource';
import { ShiftHoursValidationRepository, ShiftAlreadyValidatedError } from '../infrastructure/ShiftHoursValidationRepository';
import { AnaCareProviderNameRepository } from '../infrastructure/AnaCareProviderNameRepository';
import { mapShift, groupIntoPatients, buildSnapshot } from './AnaCareHoursMapper';
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
    private readonly providerNames: AnaCareProviderNameRepository = new AnaCareProviderNameRepository(),
  ) {}

  private async patientsForMonth(month: string, canReadNote: boolean, patientId?: string): Promise<AnaCarePatient[]> {
    const sourceShifts = await this.source.listShifts({ month, patientId });
    const validations = await this.validations.getByShiftIds(sourceShifts.map((s) => s.sourceShiftId));

    const mapped = await Promise.all(
      sourceShifts.map(async (s) => {
        const validation = validations.get(s.sourceShiftId);
        const decryptedNote = canReadNote && validation?.noteEncrypted ? await this.kms.decrypt(validation.noteEncrypted) : null;
        const shift = mapShift(s, validation, canReadNote, decryptedNote || null);
        return { shift, anaCarePatientId: s.anaCarePatientId, anaCareNurseId: s.anaCareNurseId };
      }),
    );

    const patients = groupIntoPatients(mapped);
    await this.resolveProviderNames(patients);
    return patients;
  }

  /**
   * Resolve `provider.name` em LOTE (1 query, país AR, `merged_into_id IS NULL` — condições do
   * lex) — só o lado PRESTADOR; paciente nunca ganha nome (fora de escopo, spec 003). Sem match
   * ou sem worker vinculado, `provider.name` fica `undefined` — a UI mostra o ID cru.
   */
  private async resolveProviderNames(patients: AnaCarePatient[]): Promise<void> {
    const nurseIds = Array.from(new Set(patients.flatMap((p) => p.providers.map((pr) => pr.anaCareId))));
    if (nurseIds.length === 0) return;
    const workers = await this.providerNames.findByAnaCareIds(nurseIds);
    if (workers.size === 0) return;

    await Promise.all(
      patients.flatMap((patient) =>
        patient.providers.map(async (provider) => {
          const worker = workers.get(provider.anaCareId);
          if (!worker) return;
          const [firstName, lastName] = await Promise.all([
            worker.firstNameEncrypted ? this.kms.decrypt(worker.firstNameEncrypted) : Promise.resolve(null),
            worker.lastNameEncrypted ? this.kms.decrypt(worker.lastNameEncrypted) : Promise.resolve(null),
          ]);
          const name = [firstName, lastName].filter(Boolean).join(' ').trim();
          if (name) provider.name = name;
        }),
      ),
    );
  }

  /** D4: sem filtro de query — `patientSearch`/`providerId` rodam só no CLIENTE (`selectors.ts`), nunca aqui (PII em query/log). */
  async getMonthSnapshot(month: string, canReadNote: boolean): Promise<AnaCareMonthSnapshot> {
    const [patients, retrato] = await Promise.all([this.patientsForMonth(month, canReadNote), this.source.getRetratoStatus()]);
    return buildSnapshot(month, patients, retrato);
  }

  async getPatientMonth(month: string, patientId: string, canReadNote: boolean): Promise<AnaCarePatient | null> {
    const patients = await this.patientsForMonth(month, canReadNote, patientId);
    return patients.find((p) => p.anaCareId === patientId) ?? null;
  }

  async getRetratoStatus(month: string): Promise<AnaCareRetratoStatus> {
    const snapshot = await this.getMonthSnapshot(month, false);
    return { updatedAt: snapshot.updatedAt, stale: snapshot.stale, circuitBreakerOpen: snapshot.circuitBreakerOpen };
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
        approvedHours: source!.durationHours ?? 0, // D344: sem check-in congela 0h
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
