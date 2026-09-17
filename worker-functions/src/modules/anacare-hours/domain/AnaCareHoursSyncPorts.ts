/**
 * src/modules/anacare-hours/domain/AnaCareHoursSyncPorts.ts
 *
 * Portas do sync real (F4 continuação, migration 439): o módulo `anacare-hours` não depende do
 * módulo `integration` por tipo nominal — `AnaCareEnliteDirectory` (integration) e
 * `AnaCareShiftRepository` (infra deste módulo) satisfazem estas portas ESTRUTURALMENTE, o mesmo
 * padrão que `AnaCareShiftsSource` já usa para desacoplar o serviço do adapter real/falso.
 */

import type { SourceShiftDTO } from './AnaCareShiftsSource';
import type { AnaCarePatientMonthAggregate, AnaCarePatientMonthProviderAggregate } from './AnaCarePatientMonth';

export interface EnliteDirectoryEntry {
  reservationId: string;
}

export interface EnliteDirectorySnapshot {
  entries: readonly EnliteDirectoryEntry[];
  counts: { activo: number; terminado: number; total: number };
  /** `true` quando a página de TERMINADOS não pôde ser lida (diretório real, ver `AnaCareEnliteDirectory`). */
  partial: boolean;
}

/** Descobre quais reservas (contas) do Ana Care são da Enlite — a fonte NÃO tem filtro por agência. */
export interface EnliteDirectorySource {
  fetch(): Promise<EnliteDirectorySnapshot>;
}

export interface ShiftSyncFreshness {
  /** Quantos turnos o retrato tem gravado para o mês — zero é FALHA (retrato nunca construído), nunca sucesso silencioso. */
  shifts: number;
  lastFetchedAt: string | null;
}

/** Porta de escrita/leitura do retrato (`anacare_shift`) usada pelo sync runner E pelo serviço de leitura. */
export interface ShiftSyncRepository {
  upsertMany(shifts: readonly SourceShiftDTO[], periodMonth: string): Promise<{ written: number }>;
  listByMonth(month: string, patientId?: string): Promise<SourceShiftDTO[]>;
  getSnapshotFreshness(month: string): Promise<ShiftSyncFreshness>;
  /** Última contagem TOTAL do diretório Enlite conhecida (alarme de queda) — `null` = nenhuma execução prévia. */
  getLastDirectoryCount(): Promise<number | null>;
  setLastDirectoryCount(count: number): Promise<void>;
}

/**
 * Porta de escrita/leitura do retrato AGREGADO (`anacare_patient_month`, migration 441, D361) —
 * usada pelo sync runner (grava ao lado de `anacare_shift`, convivência da F6.1) e, a partir da
 * F6.2, pelo serviço de leitura da lista.
 */
export interface PatientMonthSyncRepository {
  /**
   * Conserto 17/09 (D361 F6.1): grava um agregado JÁ PRONTO — usado hoje só pelo round-trip do
   * repositório em teste. O RUNNER não chama mais este método (ver `recomputeFromShifts`): somar
   * em memória por reserva e fazer upsert direto tinha um bug — o mesmo paciente em DUAS reservas
   * (inclusive em invocações diferentes, por causa do cursor) fazia a segunda gravação SOBRESCREVER
   * a primeira em silêncio, porque cada upsert só via os turnos de UMA reserva.
   */
  upsertMany(aggregates: readonly AnaCarePatientMonthAggregate[], periodMonth: string): Promise<{ written: number }>;
  /**
   * Recomputa e grava o(s) agregado(s) dos pacientes presentes em `shifts` a partir da fonte da
   * verdade cumulativa (durante a convivência F6.1, `anacare_shift` — já escrita pelo `upsertMany`
   * do `ShiftSyncRepository` imediatamente antes desta chamada), nunca só a partir do lote em
   * memória. Isso garante que o valor final é sempre o TOTAL do paciente no mês, venha de quantas
   * reservas vier e em quantas invocações for. `shifts` só precisa cobrir os pacientes desta
   * chamada — o NOME vem deles (não existe coluna de nome em `anacare_shift`), mas nome ausente
   * nesta rodada nunca apaga um nome já gravado (COALESCE do lado da implementação).
   */
  recomputeFromShifts(shifts: readonly SourceShiftDTO[], periodMonth: string): Promise<{ written: number }>;
  /**
   * Conserto 17/09 (fase de desacoplamento de `anacare_shift`, passo 1): grava os agregados JÁ
   * PRONTOS de UMA reserva (`aggregateByPatient` sobre os turnos DAQUELA reserva, calculado pelo
   * CHAMADOR — este método não lê `anacare_shift`) por SUBSTITUIÇÃO total da linha, nunca soma com
   * o que já existe. Como a substituição não pode mesclar com uma gravação anterior do MESMO
   * paciente vinda de outra reserva, detecta a colisão ANTES de gravar: se algum paciente do lote
   * já foi escrito NESTA MESMA corrida (`fetched_at` já gravado >= `runStartedAt`), lança
   * `AnaCarePatientMonthCollisionError` e não grava nada do lote — nunca sobrescreve calado.
   * `runStartedAt` é o carimbo da corrida (mesma rodada `runOnce`, ou propagado pelo chamador junto
   * do `cursor` ao retomar uma corrida que ficou pela metade — ver `AnaCareHoursSyncRunner`).
   * `written` reflete o que REALMENTE foi gravado (`rowCount`), nunca o tamanho do array de
   * entrada — contagem zero é falha, nunca sucesso.
   */
  upsertReplacingForRun(
    aggregates: readonly AnaCarePatientMonthAggregate[],
    periodMonth: string,
    runStartedAt: Date,
  ): Promise<{ written: number }>;
  listByMonth(source: string, periodMonth: string): Promise<AnaCarePatientMonthAggregate[]>;
  /** Mesmo contrato de `ShiftSyncFreshness.getSnapshotFreshness` — contagem zero é falha, nunca sucesso. */
  getSnapshotFreshness(source: string, periodMonth: string): Promise<ShiftSyncFreshness>;
  /**
   * Pares paciente×prestador do mês (migration 442, Adendo 17/09) — flat, agrupado por paciente
   * por quem chama (`AnaCareHoursService.getMonthSnapshot`). Alimenta `providers`/`providersCount`
   * e o filtro "Todos los prestadores" da lista.
   */
  listProvidersByMonth(source: string, periodMonth: string): Promise<AnaCarePatientMonthProviderAggregate[]>;
}
