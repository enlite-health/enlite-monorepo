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
 * F1 (migration 457, change `anacare-horas-conclusao-de-corrida`, 20/09/2026) — progresso da
 * rodada, gravado pelo CONTROLLER (`AnaCareHoursSyncController.trigger`), nunca pelo runner (que
 * não tem acesso a banco hoje). `cursor`/`reservationsTotal`/`reservationsDone` são escritos por
 * `COALESCE` na implementação real (`AnaCareSyncRunRepository.recordProgress`): passar `null`
 * nesses três campos PRESERVA o valor já gravado, nunca o apaga — é assim que uma falha no meio de
 * uma corrida (`status: 'failed'`) mantém o último cursor/contagem conhecidos em vez de zerá-los
 * (design.md §F1: "cursor/contagens ficam com o último valor conhecido antes da falha"). Já
 * `finishedAt`/`lastError` são sempre escritos EXPLICITAMENTE (o chamador sempre sabe o valor
 * certo — `null` limpa, um valor grava; nunca há "preservar" para esses dois).
 */
export interface SyncRunProgress {
  status: 'running' | 'done' | 'failed';
  /** `null` = preserva o `cursor` já gravado (COALESCE) — nunca interpretar como "limpar para NULL". */
  cursor: number | null;
  /** `null` = preserva o valor já gravado (COALESCE). */
  reservationsTotal: number | null;
  /** `null` = preserva o valor já gravado (COALESCE). */
  reservationsDone: number | null;
  /** Sempre explícito: `null` enquanto `running`, `NOW()` do banco quando `done`/`failed`. */
  finishedAt: Date | null;
  /** Código ESTÁVEL (`toStableErrorCode`) — nunca a mensagem crua da exceção. Sempre explícito. */
  lastError: string | null;
}

/**
 * Porta do carimbo da CORRIDA de sync (`anacare_sync_run`, migration 443, gate `revisao-pr` fecho
 * 17/09) — `run_started_at` passa a ser gravado com `NOW()` DO BANCO, nunca calculado no Node nem
 * recebido do cliente HTTP (ver cabeçalho da migration 443 para os 3 buracos medidos do desenho
 * anterior). Uma linha por `(source, periodMonth)`.
 */
/**
 * F2 (change `anacare-horas-conclusao-de-corrida`) — leitura da CONCLUSÃO da corrida para
 * `(source, periodMonth)`, o dado que `AnaCareHoursMapper.computeSnapshotState` usa para decidir
 * `desconhecido`/`parcial`. `status: null` cobre OS DOIS casos que não têm base para virar
 * `parcial` — nenhuma linha em `anacare_sync_run` para este mês, OU a linha existe com
 * `status IS NULL` (agosto/setembro pré-existentes) — os dois são "não sei", nunca "sei que está
 * incompleto". `reservationsTotal`/`reservationsDone` só vêm não-nulos quando o controller já
 * gravou uma rodada (nunca um `0` inventado para "sem dado").
 */
export interface SyncRunConclusion {
  status: 'running' | 'done' | 'failed' | null;
  reservationsTotal: number | null;
  reservationsDone: number | null;
}

export interface SyncRunRepository {
  /**
   * Corrida NOVA (sem cursor de retomada): grava/substitui `run_started_at = NOW()` do banco para
   * `(source, periodMonth)` e devolve o carimbo REALMENTE gravado (nunca um `Date` calculado no
   * Node) — é essa mesma fonte de relógio que `anacare_patient_month.fetched_at` usa, então a
   * comparação `fetched_at >= run_started_at` no detector de colisão nunca sofre deriva entre
   * processos.
   */
  startNewRun(source: string, periodMonth: string): Promise<Date>;
  /**
   * Retomada (cursor não-nulo): lê o carimbo já gravado para `(source, periodMonth)`. `null` =
   * nenhuma corrida registrada para este mês (ex.: banco resetado entre invocações) — o CHAMADOR
   * (`AnaCareHoursSyncRunner.resolveRunStartedAt`) trata esse caso como corrida NOVA e RELATA a
   * decisão, nunca finge silenciosamente que existia uma corrida anterior.
   */
  getRunStartedAt(source: string, periodMonth: string): Promise<Date | null>;
  /**
   * F1 (migration 457): grava o progresso da rodada — `UPDATE` na linha já existente para
   * `(source, periodMonth)` (a linha nasce em `startNewRun`, nunca aqui; este método não faz
   * `INSERT`). Chamado pelo controller a cada rodada, sucesso ou falha.
   */
  recordProgress(source: string, periodMonth: string, progress: SyncRunProgress): Promise<void>;
  /**
   * F2: lê `status`/`reservations_total`/`reservations_done` da linha de `(source, periodMonth)` —
   * único ponto de leitura da conclusão da corrida, para não duplicar o `SELECT` em cada chamador
   * (`AnaCareHoursService.getMonthSnapshot`). Ver `SyncRunConclusion` para a semântica de `null`.
   */
  getConclusion(source: string, periodMonth: string): Promise<SyncRunConclusion>;
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
