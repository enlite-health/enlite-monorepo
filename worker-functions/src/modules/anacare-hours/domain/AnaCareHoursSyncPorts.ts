/**
 * src/modules/anacare-hours/domain/AnaCareHoursSyncPorts.ts
 *
 * Portas do sync real (F4 continuação, migration 439): o módulo `anacare-hours` não depende do
 * módulo `integration` por tipo nominal — `AnaCareEnliteDirectory` (integration) e
 * `AnaCarePatientMonthRepository`/`AnaCareDirectorySnapshotRepository` (infra deste módulo)
 * satisfazem estas portas ESTRUTURALMENTE, o mesmo padrão que `AnaCareShiftsSource` já usa para
 * desacoplar o serviço do adapter real/falso.
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

/**
 * Porta do alarme de queda do diretório Enlite (`anacare_directory_snapshot`, migration 439).
 * Separada de `PatientMonthSyncRepository` (passo 2 do conserto 17/09): antes vivia dentro do
 * repositório do retrato POR TURNO (`AnaCareShiftRepository`) mesmo sem ter nada a ver com turno —
 * guardava só a última contagem TOTAL do diretório, usada pelo `AnaCareHoursSyncRunner` para
 * detectar a raspagem quebrando em silêncio.
 */
export interface DirectorySnapshotRepository {
  /** Última contagem TOTAL do diretório Enlite conhecida (alarme de queda) — `null` = nenhuma execução prévia. */
  getLastDirectoryCount(): Promise<number | null>;
  setLastDirectoryCount(count: number): Promise<void>;
}

/**
 * Porta de escrita/leitura do retrato AGREGADO (`anacare_patient_month` +
 * `anacare_patient_month_provider`, migrations 441/442, D361) — usada pelo sync runner e pelo
 * serviço de leitura da lista.
 */
export interface PatientMonthSyncRepository {
  /**
   * Conserto 17/09 (D361 F6.1): grava um agregado JÁ PRONTO — usado hoje só pelo round-trip do
   * repositório em teste. O RUNNER não chama mais este método (ver `upsertReplacingForRun`): somar
   * em memória por reserva e fazer upsert direto tinha um bug — o mesmo paciente em DUAS reservas
   * (inclusive em invocações diferentes, por causa do cursor) fazia a segunda gravação SOBRESCREVER
   * a primeira em silêncio, porque cada upsert só via os turnos de UMA reserva.
   */
  upsertMany(aggregates: readonly AnaCarePatientMonthAggregate[], periodMonth: string): Promise<{ written: number }>;
  /**
   * Conserto 17/09 (fase de desacoplamento do retrato por turno, passo 1): grava os agregados JÁ
   * PRONTOS de UMA reserva (`aggregateByPatient` sobre os turnos DAQUELA reserva, calculado pelo
   * CHAMADOR) por SUBSTITUIÇÃO total da linha, nunca soma com o que já existe. Como a substituição
   * não pode mesclar com uma gravação anterior do MESMO paciente vinda de outra reserva, detecta a
   * colisão ANTES de gravar: se algum paciente do lote já foi escrito NESTA MESMA corrida
   * (`fetched_at` já gravado >= `runStartedAt`), lança `AnaCarePatientMonthCollisionError` e não
   * grava nada do lote — nunca sobrescreve calado. `runStartedAt` é o carimbo da corrida (mesma
   * rodada `runOnce`, ou propagado pelo chamador junto do `cursor` ao retomar uma corrida que ficou
   * pela metade — ver `AnaCareHoursSyncRunner`). `written` reflete o que REALMENTE foi gravado
   * (`rowCount`), nunca o tamanho do array de entrada — contagem zero é falha, nunca sucesso.
   *
   * Conserto 17/09 (passo 3, regressão do passo 1): `shifts` — os turnos EM MEMÓRIA da MESMA
   * reserva que originou `aggregates` (`aggregateByPatient(shifts) === aggregates`) — grava
   * TAMBÉM o par paciente×prestador (`anacare_patient_month_provider`, migration 442) NA MESMA
   * transação do agregado (ver decisão na implementação). Sem isso o par nunca é escrito por
   * produção nenhuma e o filtro "Todos los prestadores" da lista congela (D362). `shifts` vazio
   * (`[]`) é válido e pula a escrita de pares sem abrir query extra.
   */
  upsertReplacingForRun(
    aggregates: readonly AnaCarePatientMonthAggregate[],
    periodMonth: string,
    runStartedAt: Date,
    shifts: readonly SourceShiftDTO[],
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
