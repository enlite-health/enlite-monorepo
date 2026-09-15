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

export interface MonthSnapshotFilters {
  patientSearch?: string;
  providerId?: string;
}

export interface ValidateBatchItemResult {
  shiftId: string;
  ok: boolean;
  code?: string;
}

/** Normaliza pra comparação de filtro: minúsculo, sem espaço nas pontas (sem acento — não há nome exposto em F1). */
const norm = (s: string): string => s.trim().toLowerCase();

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

    return groupIntoPatients(mapped);
  }

  async getMonthSnapshot(month: string, canReadNote: boolean, filters: MonthSnapshotFilters = {}): Promise<AnaCareMonthSnapshot> {
    let patients = await this.patientsForMonth(month, canReadNote);

    if (filters.providerId) {
      const wanted = filters.providerId;
      patients = patients
        .map((p) => ({ ...p, providers: p.providers.filter((pr) => pr.anaCareId === wanted) }))
        .filter((p) => p.providers.length > 0);
    }
    if (filters.patientSearch) {
      const needle = norm(filters.patientSearch);
      patients = patients.filter((p) => norm(p.name ?? p.anaCareId).includes(needle));
    }

    return buildSnapshot(month, patients);
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

  async validateShift(shiftId: string, validatorUid: string): Promise<void> {
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

  /** Valida cada turno independentemente — um 409 isolado não derruba os demais (batch parcial). */
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
      throw new AnaCareHoursServiceError('NOTA_OBRIGATORIA', `nota acima do limite de ${CONTEST_NOTE_MAX_LENGTH} caracteres`);
    }
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
