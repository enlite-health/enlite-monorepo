/**
 * Interface do serviço que a tela chama. Cumpre exatamente o contrato de `types.ts`, que aponta
 * pra proposta de schema (`docs/funcionalidades/ana-care/proposta-schema-validacao-horas.md`).
 * `AnaCareHoursHttpService` (`AnaCareHoursHttpService.ts`) é a implementação REAL, batendo no
 * contrato HTTP fixo da fase 1. `FakeAnaCareHoursService` é a implementação em memória — só para
 * TESTES UNITÁRIOS agora (o harness de preview do protótipo não foi portado, task do brief).
 * Hooks, containers e páginas dependem só desta interface — trocar a implementação injetada não
 * muda uma linha delas (ver `AnaCareHours/README.md` do protótipo, mesma regra aqui).
 */
import {
  CONTEST_NOTE_MAX_LENGTH,
  CONTEST_REASONS,
  type AnaCareMonthSnapshot,
  type AnaCarePatient,
  type AnaCareRetratoStatus,
  type ContestShiftCommand,
  type ValidateBatchCommand,
  type ValidateShiftCommand,
} from './types';
import { filterPatients, type AnaCareHoursClientFilters } from './selectors';

export type AnaCareHoursMonthFilters = AnaCareHoursClientFilters;

export interface AnaCareHoursService {
  /** Mês completo (já filtrado, se `filters` vier) — alimenta a lista. */
  getMonthSnapshot(month: string, filters?: AnaCareHoursMonthFilters): Promise<AnaCareMonthSnapshot>;
  /** Um paciente só, no mês — alimenta o detalhe (evita reprocessar o mês inteiro na tela). */
  getPatientMonth(month: string, patientId: string): Promise<AnaCarePatient | null>;
  /** Estado do retrato isolado (sem o payload do mês) — pro banner de "desatualizado" sozinho. */
  getRetratoStatus(month: string): Promise<AnaCareRetratoStatus>;
  validateShift(command: ValidateShiftCommand): Promise<void>;
  validateBatch(command: ValidateBatchCommand): Promise<void>;
  contestShift(command: ContestShiftCommand): Promise<void>;
}

/** Latência artificial do Fake — nunca real, só simula rede pro loading ser visível em teste/harness. */
const FAKE_LATENCY_MS = 0;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), FAKE_LATENCY_MS));
}

/** Erro de regra de negócio recusada — mesma forma que o backend real devolve (400/404/409/503). */
export class AnaCareHoursServiceError extends Error {
  readonly code:
    | 'RETRATO_DESATUALIZADO'
    | 'JA_VALIDADO'
    | 'MOTIVO_INVALIDO'
    | 'NOTA_MUITO_LONGA'
    | 'FONTE_NAO_CONFIGURADA'
    | 'TURNO_NAO_ENCONTRADO'
    | 'DESCONHECIDO';
  constructor(code: AnaCareHoursServiceError['code'], message: string) {
    super(message);
    this.name = 'AnaCareHoursServiceError';
    this.code = code;
  }
}

/**
 * Valida o comando de contestação com a MESMA regra que o backend real aplica (1.5b, D344):
 * `reason` tem de ser um dos valores da lista fechada; `note`, se vier, não pode passar do
 * limite. Extraído para ser chamado tanto pelo Fake (que se comporta como o backend faria) quanto
 * reaproveitado nos testes do `AnaCareHoursHttpService` (o backend real valida de novo — o front
 * nunca confia só na própria checagem, é defesa em profundidade, não substituição).
 */
export function assertValidContestCommand(command: Pick<ContestShiftCommand, 'reason' | 'note'>): void {
  if (!CONTEST_REASONS.includes(command.reason)) {
    throw new AnaCareHoursServiceError('MOTIVO_INVALIDO', 'El motivo de la contestación no es válido.');
  }
  if (command.note && command.note.length > CONTEST_NOTE_MAX_LENGTH) {
    throw new AnaCareHoursServiceError('NOTA_MUITO_LONGA', `La nota no puede superar los ${CONTEST_NOTE_MAX_LENGTH} caracteres.`);
  }
}

export class FakeAnaCareHoursService implements AnaCareHoursService {
  constructor(private snapshots: Record<string, AnaCareMonthSnapshot>) {}

  private findSnapshot(month: string): AnaCareMonthSnapshot {
    return (
      this.snapshots[month] ?? {
        month,
        updatedAt: new Date().toISOString(),
        stale: false,
        circuitBreakerOpen: false,
        patients: [],
      }
    );
  }

  async getMonthSnapshot(month: string, filters?: AnaCareHoursMonthFilters): Promise<AnaCareMonthSnapshot> {
    const snapshot = this.findSnapshot(month);
    return delay({ ...snapshot, patients: filterPatients(snapshot.patients, filters) });
  }

  async getPatientMonth(month: string, patientId: string): Promise<AnaCarePatient | null> {
    const snapshot = this.findSnapshot(month);
    const patient = snapshot.patients.find((p) => p.anaCareId === patientId) ?? null;
    return delay(patient);
  }

  async getRetratoStatus(month: string): Promise<AnaCareRetratoStatus> {
    const snapshot = this.findSnapshot(month);
    return delay({
      updatedAt: snapshot.updatedAt,
      stale: snapshot.stale,
      circuitBreakerOpen: snapshot.circuitBreakerOpen,
    });
  }

  private assertRetratoOk(month: string): void {
    const snapshot = this.findSnapshot(month);
    if (snapshot.stale || snapshot.circuitBreakerOpen) {
      throw new AnaCareHoursServiceError(
        'RETRATO_DESATUALIZADO',
        'Retrato desactualizado — ninguna acción de escritura es aceptada hasta el próximo retrato.',
      );
    }
  }

  private findShiftMonth(shiftId: string): string | null {
    for (const [month, snapshot] of Object.entries(this.snapshots)) {
      for (const patient of snapshot.patients) {
        for (const provider of patient.providers) {
          if (provider.shifts.some((s) => s.id === shiftId)) return month;
        }
      }
    }
    return null;
  }

  private mutateShift(shiftId: string, mutate: (shift: AnaCareMonthSnapshot['patients'][number]['providers'][number]['shifts'][number]) => void): void {
    for (const snapshot of Object.values(this.snapshots)) {
      for (const patient of snapshot.patients) {
        for (const provider of patient.providers) {
          const shift = provider.shifts.find((s) => s.id === shiftId);
          if (shift) {
            mutate(shift);
            return;
          }
        }
      }
    }
  }

  async validateShift({ shiftId }: ValidateShiftCommand): Promise<void> {
    const month = this.findShiftMonth(shiftId);
    if (month) this.assertRetratoOk(month);

    let found = false;
    let alreadyValidated = false;
    this.mutateShift(shiftId, (shift) => {
      found = true;
      if (shift.status === 'validado') {
        alreadyValidated = true;
        return;
      }
      // Contestado também pode ser validado depois — só validado congela.
      shift.status = 'validado';
      shift.validatedBy = { id: 'e2e-qa', name: 'Equipo Enlite QA' };
      shift.validatedAt = new Date().toISOString();
    });
    if (!found) return delay(undefined);
    if (alreadyValidated) {
      throw new AnaCareHoursServiceError('JA_VALIDADO', 'Este turno ya fue validado — no puede reabrirse.');
    }
    return delay(undefined);
  }

  async validateBatch({ shiftIds }: ValidateBatchCommand): Promise<void> {
    // Lote é por LISTA DE IDs — pode misturar turnos de prestadores (e pacientes) diferentes,
    // desde que estejam no mesmo retrato/mês (a tela só monta seleção dentro de um paciente).
    // Recusa o LOTE INTEIRO (nenhum turno é tocado) se qualquer mês envolvido estiver com
    // retrato desatualizado — confere TODOS antes de mutar qualquer um.
    const months = new Set<string>();
    for (const shiftId of shiftIds) {
      const month = this.findShiftMonth(shiftId);
      if (month) months.add(month);
    }
    for (const month of months) {
      this.assertRetratoOk(month);
    }

    // Contestado TAMBÉM pode ser validado (só validado CONGELA e nunca reabre). Um turno já
    // `validado` no lote é ignorado em silêncio — a tela já filtra antes de montar `shiftIds`
    // (checkbox desaparece pra validado), mas o Fake não confia na tela: recusa a MESMA regra
    // na borda, igual um backend real faria.
    for (const shiftId of shiftIds) {
      this.mutateShift(shiftId, (shift) => {
        if (shift.status === 'validado') return;
        shift.status = 'validado';
        shift.validatedBy = { id: 'e2e-qa', name: 'Equipo Enlite QA' };
        shift.validatedAt = new Date().toISOString();
      });
    }
    return delay(undefined);
  }

  async contestShift({ shiftId, reason, note }: ContestShiftCommand): Promise<void> {
    assertValidContestCommand({ reason, note });
    const month = this.findShiftMonth(shiftId);
    if (month) this.assertRetratoOk(month);

    this.mutateShift(shiftId, (shift) => {
      shift.status = 'contestado';
      shift.contestReason = reason;
      shift.contestNote = note?.trim() ? note.trim() : undefined;
      shift.validatedBy = undefined;
      shift.validatedAt = undefined;
    });
    return delay(undefined);
  }
}
