/**
 * src/modules/anacare-hours/application/AnaCareHoursSyncRunner.ts
 *
 * F4 (tasks 4.1-4.9) — sync real do retrato de turnos, por RESERVA (não por varredura do mês
 * inteiro): a API do Ana Care não tem filtro por agência (medido 17/09, 5 nomes de parâmetro
 * testados, todos ignorados), então a única forma barata de saber "isto é da Enlite" é o
 * diretório raspado (`AnaCareEnliteDirectory`, 283 contas medidas) — e cada reserva filtra no
 * servidor via `reservationId` (medido: 1 página por paciente/mês, teto teórico ~2 páginas).
 *
 * Cursor + orçamento de tempo: 283 reservas × ~1,5s ≈ 7min, e o Cloud Run tem 600s de teto — o
 * runner para ao esgotar o orçamento e devolve `nextCursor` (índice na lista ORDENADA de reservas,
 * idempotente e retomável).
 *
 * Alarme de queda do diretório: a raspagem quebra em SILÊNCIO (menos linhas, nunca erro de rede)
 * — antes de gravar qualquer coisa, a contagem nova é comparada contra a última CONHECIDA
 * (`ShiftSyncRepository.getLastDirectoryCount`, migration 439); abaixo do piso relativo (80%) OU
 * do piso absoluto (`ANACARE_DIRECTORY_MIN_ABSOLUTE`, env — sem histórico E sem essa env, o runner
 * é FAIL-CLOSED na 1ª rodada, ver `AnaCareDirectoryFirstRunNotConfiguredError`; referência medida
 * 17/09: 283 contas, piso configurado em stage: 226 = 80%), o runner FALHA sem gravar nada.
 *
 * Mesmo guard de dedup (4.8) e emissor de métrica (4.9) da versão anterior — o "limitador" aqui
 * continua sendo só o dedup de disparo concorrente; o rate-limit real de requisições (D341) é do
 * `AnaCareSessionClient` (F2), não deste runner.
 */

import { logger } from '@shared/logging';
import type { AnaCareShiftsSource } from '../domain/AnaCareShiftsSource';
import type { DirectorySnapshotRepository, EnliteDirectorySource, PatientMonthSyncRepository, SyncRunRepository } from '../domain/AnaCareHoursSyncPorts';
import { AnaCareHoursSyncGuard } from './AnaCareHoursSyncGuard';
import { emitAnaCareHoursSyncMetric, type AnaCareHoursSyncMetricEmitter } from '../infrastructure/AnaCareHoursSyncMetrics';
import { FakeEnliteDirectory, FakeAnaCareDirectorySnapshotRepository, FakeAnaCarePatientMonthRepository, FakeAnaCareSyncRunRepository } from '../infrastructure/FakeAnaCareSyncDependencies';
import { aggregateByPatient } from './AnaCarePatientMonthAggregator';

export interface AnaCareHoursSyncTrigger {
  origin: 'cron' | 'manual';
  userId: string | null;
  /** YYYY-MM — default: mês corrente (`monthResolver`). */
  month?: string;
  /** Índice na lista ordenada de reservas de onde retomar — `null`/omitido = começar do zero. */
  cursor?: number | null;
  /** Orçamento de tempo da rodada (ms) — default 420000 (7min), deixa folga pro teto de 600s do Cloud Run. */
  budgetMs?: number;
}

export interface AnaCareHoursSyncOutcome {
  requests: number;
  retries: number;
  shiftsRead: number;
  deduped: boolean;
  reservationsProcessed: number;
  shiftsWritten: number;
  /** `null` = terminou a lista inteira de reservas nesta rodada. */
  nextCursor: number | null;
  /**
   * F1 (migration 457, change `anacare-horas-conclusao-de-corrida`) — `reservationIds.length`
   * desta rodada. Não é medição nova: já existia em memória dentro de `runOnce` e era jogado fora
   * no retorno; esta mudança só para de perdê-lo na borda do método.
   */
  reservationsTotal: number;
  /**
   * F1 (migration 457): índice absoluto `i` no momento em que `runOnce` retornou — seja por fim da
   * lista, seja por corte de orçamento de tempo. Quanto da lista já foi percorrido ao todo,
   * somando rodadas anteriores retomadas por cursor (não confundir com `reservationsProcessed`,
   * que conta só o que ESTA rodada processou).
   */
  reservationsDone: number;
  directoryCounts: { activo: number; terminado: number; total: number };
  /**
   * Turnos descartados na minimização por faltar prestador — nunca em silêncio (conserto 17/09:
   * 500 medido em produção, `raw.nurse === null` em 15/3.421 turnos, 0,4%). Somado por rodada,
   * sobre todas as reservas processadas.
   */
  shiftsSkippedNoProvider: number;
  /** Irmã de `shiftsSkippedNoProvider` — turno sem paciente (medido 0/3.421, tipo admite mesmo assim). */
  shiftsSkippedNoPatient: number;
  /**
   * ISO do carimbo desta corrida — o SERVIDOR que decide (migration 443, `SyncRunRepository`),
   * nunca o cliente: só sai na RESPOSTA para observabilidade (o script de medição loga, não
   * reenvia). Ver `AnaCareHoursSyncRunner.resolveRunStartedAt`.
   */
  runStartedAt: string;
}

const DEFAULT_BUDGET_MS = 420_000;

/** Falha nomeada — distingue "diretório caiu" de qualquer outro erro genérico (mesmo padrão de `AnaCareEnliteDirectoryError`). */
export class AnaCareDirectoryDroppedError extends Error {
  constructor(
    readonly newTotal: number,
    readonly lastKnownTotal: number | null,
    readonly floor: number,
  ) {
    super(
      `[AnaCareHoursSyncRunner] diretório caiu de ${lastKnownTotal ?? 'desconhecido'} para ${newTotal} ` +
        `(piso ${floor}) — raspagem provavelmente quebrada; nada foi gravado.`,
    );
  }
}

/**
 * Item 4 (revisão de PR): fail-closed na PRIMEIRA rodada. Antes, sem `lastKnown` (histórico) o piso
 * relativo virava 0 e o absoluto tinha default PERMISSIVO (`1`) — como `extractAccountIds` já
 * lança com zero ids, o alarme de queda do diretório NUNCA disparava na 1ª rodada, e o total dessa
 * rodada (mesmo quebrado) virava a linha-base para sempre (`setLastDirectoryCount`). Contagem zero
 * — e contagem sem régua — é falha, nunca sucesso: sem histórico E sem `ANACARE_DIRECTORY_MIN_ABSOLUTE`
 * configurada, o runner recusa a rodada com este erro nomeado, em vez de aceitar qualquer contagem.
 */
export class AnaCareDirectoryFirstRunNotConfiguredError extends Error {
  constructor() {
    super(
      '[AnaCareHoursSyncRunner] primeira rodada (sem histórico de contagem do diretório) e ' +
        'ANACARE_DIRECTORY_MIN_ABSOLUTE não configurada — recusado por fail-closed (contagem zero/sem ' +
        'régua é falha, nunca sucesso). Configure a env antes de rodar (referência medida 17/09: 283 ' +
        'contas totais, piso sugerido 226 = 80%).',
    );
  }
}

type RunOnceResult = Omit<AnaCareHoursSyncOutcome, 'deduped'>;

export class AnaCareHoursSyncRunner {
  constructor(
    private readonly source: AnaCareShiftsSource,
    private readonly guard: AnaCareHoursSyncGuard<RunOnceResult> = new AnaCareHoursSyncGuard(),
    private readonly emitMetric: AnaCareHoursSyncMetricEmitter = emitAnaCareHoursSyncMetric,
    private readonly monthResolver: () => string = AnaCareHoursSyncRunner.currentMonth,
    private readonly directory: EnliteDirectorySource = new FakeEnliteDirectory(),
    /**
     * Conserto 17/09 (desacoplamento do retrato por turno, passo 1): `runOnce` NÃO grava mais
     * turnos — este repositório serve só ao alarme de queda do diretório
     * (`getLastDirectoryCount`/`setLastDirectoryCount`). Passo 2 extraiu o tipo para
     * `DirectorySnapshotRepository` (antes vivia dentro do repositório do retrato por turno, sem
     * ter nada a ver com turno) e apagou o repositório antigo por completo.
     */
    private readonly directorySnapshotRepository: DirectorySnapshotRepository = new FakeAnaCareDirectorySnapshotRepository(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    /**
     * F6.1 (D361) → conserto 17/09 (passo 1): grava o retrato AGREGADO (`anacare_patient_month`,
     * migration 441) por SUBSTITUIÇÃO (`upsertReplacingForRun`) a partir do agregado em memória de
     * CADA reserva, e (passo 3) o par paciente×prestador (`anacare_patient_month_provider`) na
     * MESMA chamada — não depende do retrato por turno como fonte cumulativa.
     */
    private readonly patientMonthRepository: PatientMonthSyncRepository = new FakeAnaCarePatientMonthRepository(),
    /**
     * Gate `revisao-pr` (fecho 17/09): o carimbo da corrida (`anacare_sync_run`, migration 443)
     * passa a ser do SERVIDOR — nunca mais recebido no corpo HTTP nem calculado no Node com
     * `Date.now()`. Ver `resolveRunStartedAt`.
     */
    private readonly syncRunRepository: SyncRunRepository = new FakeAnaCareSyncRunRepository(),
  ) {}

  static currentMonth(): string {
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${now.getUTCFullYear()}-${month}`;
  }

  /** `null` = env ausente ou não numérica — "não configurada", nunca um piso 0 implícito. */
  private minAbsoluteFloor(): number | null {
    const raw = this.env.ANACARE_DIRECTORY_MIN_ABSOLUTE;
    if (raw === undefined) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  /**
   * Contagem zero é falha, nunca sucesso: compara a nova contagem total contra a última CONHECIDA
   * (piso relativo 80%) e contra o piso absoluto — lança ANTES de qualquer escrita.
   *
   * Item 4 (revisão de PR): sem histórico (`lastKnown===null`) E sem piso absoluto configurado, o
   * runner RECUSA a rodada (`AnaCareDirectoryFirstRunNotConfiguredError`) em vez de aceitar
   * qualquer contagem como linha-base — antes, o default permissivo (`1`) deixava a 1ª rodada
   * sempre passar, mesmo com a raspagem quebrada, e essa contagem virava a baseline pra sempre.
   */
  private async assertDirectoryHealthy(newTotal: number): Promise<number | null> {
    const lastKnown = await this.directorySnapshotRepository.getLastDirectoryCount();
    const floorAbsolute = this.minAbsoluteFloor();
    if (lastKnown === null && floorAbsolute === null) {
      throw new AnaCareDirectoryFirstRunNotConfiguredError();
    }
    const floorRelative = lastKnown !== null ? Math.floor(lastKnown * 0.8) : 0;
    const floor = Math.max(floorAbsolute ?? 0, floorRelative);
    if (newTotal < floor) {
      throw new AnaCareDirectoryDroppedError(newTotal, lastKnown, floor);
    }
    return lastKnown;
  }

  /** Uma rodada real: diretório → por reserva → grava. Nunca chamado fora do guard (`run`). */
  private async runOnce(month: string, cursor: number | null, budgetMs: number, runStartedAt: Date): Promise<RunOnceResult> {
    const directorySnapshot = await this.directory.fetch();
    await this.assertDirectoryHealthy(directorySnapshot.counts.total);
    await this.directorySnapshotRepository.setLastDirectoryCount(directorySnapshot.counts.total);

    const reservationIds = Array.from(new Set(directorySnapshot.entries.map((e) => e.reservationId))).sort();
    const startIndex = cursor ?? 0;
    const deadline = Date.now() + budgetMs;

    let requests = 0;
    let shiftsRead = 0;
    let shiftsWritten = 0;
    let reservationsProcessed = 0;
    let shiftsSkippedNoProvider = 0;
    let shiftsSkippedNoPatient = 0;
    let i = startIndex;

    for (; i < reservationIds.length; i += 1) {
      if (Date.now() >= deadline) break;
      const reservationId = reservationIds[i];
      const { shifts, skipped } = await this.source.listShifts({ month, reservationId });
      requests += 1;
      shiftsRead += shifts.length;
      shiftsSkippedNoProvider += skipped.noProvider;
      shiftsSkippedNoPatient += skipped.noPatient;
      if (shifts.length > 0) {
        // Conserto 17/09 (desacoplamento do retrato por turno, passo 1): não grava mais o retrato
        // por turno — o agregado é calculado em memória SÓ com os turnos DESTA reserva
        // (`aggregateByPatient`) e gravado por SUBSTITUIÇÃO; como isso não pode mesclar com uma
        // gravação anterior do MESMO paciente vinda de outra reserva, `upsertReplacingForRun`
        // detecta a colisão (via `runStartedAt`) e falha alto em vez de sobrescrever calado — ver
        // cabeçalho do arquivo e `AnaCarePatientMonthCollisionError`. Passo 3 (regressão do passo
        // 1): `shifts` também vai junto — é dali que `upsertReplacingForRun` grava o par
        // paciente×prestador (`anacare_patient_month_provider`) na MESMA chamada.
        const aggregates = aggregateByPatient(shifts);
        const { written } = await this.patientMonthRepository.upsertReplacingForRun(aggregates, month, runStartedAt, shifts);
        shiftsWritten += written;
      }
      reservationsProcessed += 1;
    }

    const nextCursor = i < reservationIds.length ? i : null;

    return {
      requests,
      retries: 0,
      shiftsRead,
      reservationsProcessed,
      shiftsWritten,
      nextCursor,
      // F1 (migration 457): sobreviventes de `reservationIds.length` e do `i` absoluto — ver
      // comentários dos dois campos em `AnaCareHoursSyncOutcome`.
      reservationsTotal: reservationIds.length,
      reservationsDone: i,
      directoryCounts: directorySnapshot.counts,
      shiftsSkippedNoProvider,
      shiftsSkippedNoPatient,
      runStartedAt: runStartedAt.toISOString(),
    };
  }

  /**
   * Gate `revisao-pr` (fecho 17/09): resolve o carimbo da corrida pelo SERVIDOR, nunca pelo
   * cliente. Corrida NOVA (sem cursor) sempre grava um carimbo próprio (`startNewRun`, `NOW()` do
   * banco) — mesmo que já exista um de uma corrida anterior para o mesmo mês, ele é substituído
   * (uma corrida nova começa um carimbo novo, por definição). Retomada (cursor não-nulo) LÊ o
   * carimbo já gravado; se não houver nenhum (`getRunStartedAt` devolve `null` — ex.: banco
   * resetado entre invocações, ou 1ª chamada desta corrida perdeu a escrita), trata como corrida
   * NOVA e RELATA a decisão no log — nunca finge que existia uma corrida anterior.
   */
  private async resolveRunStartedAt(source: string, month: string, cursor: number | null): Promise<Date> {
    if (cursor === null) {
      return this.syncRunRepository.startNewRun(source, month);
    }
    const existing = await this.syncRunRepository.getRunStartedAt(source, month);
    if (existing !== null) return existing;
    logger.warn({
      msg: '[AnaCareHoursSyncRunner] retomada (cursor definido) sem corrida registrada para o mês — tratando como corrida NOVA',
      source,
      month,
      cursor,
    });
    return this.syncRunRepository.startNewRun(source, month);
  }

  /**
   * Roda uma sincronização. Concorrência: duas chamadas simultâneas (manual + cron) resultam em
   * UMA rodada real (`deduped: false`) e a(s) outra(s) compartilham o resultado (`deduped: true`)
   * — nenhuma rodada extra bate na fonte. Todo disparo, deduped ou não, emite a métrica de
   * custo/consumo (4.9) — inclusive a chamada deduped, para a origem concorrente ficar visível.
   */
  async run(trigger: AnaCareHoursSyncTrigger): Promise<AnaCareHoursSyncOutcome> {
    const month = trigger.month ?? this.monthResolver();
    const cursor = trigger.cursor ?? null;
    const budgetMs = trigger.budgetMs ?? DEFAULT_BUDGET_MS;

    const startedAt = Date.now();
    // Gate `revisao-pr` (fecho 17/09, achado 🟠): `resolveRunStartedAt` só pode rodar DENTRO do
    // `guard.run` — o guard decide se esta chamada é a líder ANTES de invocar a função passada
    // (checagem síncrona de `this.inFlight`), então uma chamada DESCARTADA pelo dedup nunca chega
    // a chamar `fn` e, portanto, nunca escreve `run_started_at`. Antes, `resolveRunStartedAt`
    // rodava incondicionalmente ANTES do `guard.run`: a chamada descartada ainda assim executava
    // `startNewRun` (`ON CONFLICT DO UPDATE`), sobrescrevendo o carimbo da corrida em andamento com
    // um `NOW()` posterior — a corrida em voo seguia com t1, o banco passava a guardar t2 > t1, e
    // uma retomada por cursor que lesse t2 deixaria de detectar colisões das linhas escritas entre
    // t1 e t2.
    // Chave do dedup: o MÊS (D398/gate revisao-pr) — dois disparos concorrentes só compartilham a
    // rodada quando pedem o MESMO mês; meses diferentes rodam cada um a sua própria rodada real,
    // nunca herdam status/cursor um do outro (ver cabeçalho de `AnaCareHoursSyncGuard`).
    const { result, deduped } = await this.guard.run(month, async () => {
      const runStartedAt = await this.resolveRunStartedAt('anacare', month, cursor);
      return this.runOnce(month, cursor, budgetMs, runStartedAt);
    });

    const durationMs = Date.now() - startedAt;
    this.emitMetric({
      event: 'anacare_hours_sync',
      origin: trigger.origin,
      userId: trigger.origin === 'manual' ? trigger.userId : null,
      requests: deduped ? 0 : result.requests,
      retries: result.retries,
      durationMs,
      deduped,
    });

    return { ...result, deduped };
  }
}
