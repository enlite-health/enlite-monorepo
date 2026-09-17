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

import type { AnaCareShiftsSource } from '../domain/AnaCareShiftsSource';
import type { EnliteDirectorySource, ShiftSyncRepository } from '../domain/AnaCareHoursSyncPorts';
import { AnaCareHoursSyncGuard } from './AnaCareHoursSyncGuard';
import { emitAnaCareHoursSyncMetric, type AnaCareHoursSyncMetricEmitter } from '../infrastructure/AnaCareHoursSyncMetrics';
import { FakeEnliteDirectory, FakeAnaCareShiftRepository } from '../infrastructure/FakeAnaCareSyncDependencies';

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
  directoryCounts: { activo: number; terminado: number; total: number };
  /**
   * Turnos descartados na minimização por faltar prestador — nunca em silêncio (conserto 17/09:
   * 500 medido em produção, `raw.nurse === null` em 15/3.421 turnos, 0,4%). Somado por rodada,
   * sobre todas as reservas processadas.
   */
  shiftsSkippedNoProvider: number;
  /** Irmã de `shiftsSkippedNoProvider` — turno sem paciente (medido 0/3.421, tipo admite mesmo assim). */
  shiftsSkippedNoPatient: number;
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
    private readonly repository: ShiftSyncRepository = new FakeAnaCareShiftRepository(),
    private readonly env: NodeJS.ProcessEnv = process.env,
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
    const lastKnown = await this.repository.getLastDirectoryCount();
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
  private async runOnce(month: string, cursor: number | null, budgetMs: number): Promise<RunOnceResult> {
    const directorySnapshot = await this.directory.fetch();
    await this.assertDirectoryHealthy(directorySnapshot.counts.total);
    await this.repository.setLastDirectoryCount(directorySnapshot.counts.total);

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
        const { written } = await this.repository.upsertMany(shifts, month);
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
      directoryCounts: directorySnapshot.counts,
      shiftsSkippedNoProvider,
      shiftsSkippedNoPatient,
    };
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
    const { result, deduped } = await this.guard.run(() => this.runOnce(month, cursor, budgetMs));

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
