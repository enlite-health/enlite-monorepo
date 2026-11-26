import { PresenceUnavailableError } from '../application/ports/PresenceReaderPort';
import {
  PresenceReviewUpstreamError,
  REVIEW_KINDS,
  type DecideExceptionInput,
  type DecideExceptionResult,
  type PresenceReviewGateway,
  type ReviewKind,
  type ReviewQueueEntry,
  type ReviewQueuePageResult,
} from '../application/ports/PresenceReviewPorts';
import { attendanceAuth, googleIdTokenHeaders, presenceOptsFromEnv, type HttpPresenceReaderOpts, type IdTokenHeaders } from './HttpPresenceReader';

/** A fila é lida por uma pessoa no painel: aguenta mais que o lookup do informe (2 s), menos que o job (10 s). */
const DEFAULT_TIMEOUT_MS = 5_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: ReadonlySet<string> = new Set(REVIEW_KINDS);
const UPSTREAM_CODES: ReadonlySet<string> = new Set(['EXCEPTION_ALREADY_DECIDED', 'EXCEPTION_NOT_FOUND', 'INVALID_CURSOR']);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const nullableInt = (v: unknown): number | null | undefined => (v === null ? null : typeof v === 'number' && Number.isInteger(v) ? v : undefined);

/**
 * Cliente do attendance para a fila e a decisão (emenda 077 §4.6): `GET /internal/v1/presence/review-queue` e
 * `POST /internal/v1/presence/exceptions/{event_id}/decision`. MESMA auth (`attendanceAuth`/`googleIdTokenHeaders`, `ATTENDANCE_AUTH=none` só fora de
 * produção) e mesma base dos outros leitores do attendance — nada duplicado. Falha de rede/contrato → `PresenceUnavailableError` (código curto);
 * 400/404/409 do attendance → `PresenceReviewUpstreamError` com `code` de conjunto fechado. Nunca loga corpo nem token.
 */
export class HttpAttendancePresenceReviewGateway implements PresenceReviewGateway {
  private readonly idToken: IdTokenHeaders;

  constructor(private readonly opts: HttpPresenceReaderOpts = presenceOptsFromEnv()) {
    this.idToken = opts.idToken ?? googleIdTokenHeaders();
  }

  async queue(query: { country: string; kind?: ReviewKind; cursor?: string }): Promise<ReviewQueuePageResult> {
    const qs = new URLSearchParams({ country: query.country });
    if (query.kind) qs.set('kind', query.kind);
    if (query.cursor) qs.set('cursor', query.cursor);
    const body = await this.call('GET', `/internal/v1/presence/review-queue?${qs.toString()}`);
    const page = body as { items?: unknown; next_cursor?: unknown } | null;
    if (!page || !Array.isArray(page.items) || (page.next_cursor !== null && typeof page.next_cursor !== 'string')) throw new PresenceUnavailableError('resposta_invalida');
    return { items: page.items.map(toEntry), nextCursor: page.next_cursor };
  }

  async decide(input: DecideExceptionInput): Promise<DecideExceptionResult> {
    const body = (await this.call('POST', `/internal/v1/presence/exceptions/${encodeURIComponent(input.eventId)}/decision`, {
      decision: input.decision,
      resolution_code: input.resolutionCode,
      decided_by_uid: input.decidedByUid,
    })) as { event_id?: unknown; decision?: unknown; resolution_code?: unknown } | null;
    if (!body || !isUuid(body.event_id) || (body.decision !== 'APPROVED' && body.decision !== 'REFUSED') || typeof body.resolution_code !== 'string') {
      throw new PresenceUnavailableError('resposta_invalida');
    }
    return { eventId: body.event_id, decision: body.decision, resolutionCode: body.resolution_code };
  }

  private async call(method: 'GET' | 'POST', pathAndQuery: string, json?: Record<string, unknown>): Promise<unknown> {
    const base = this.opts.baseUrl?.replace(/\/+$/, '');
    if (!base) throw new PresenceUnavailableError('sem_url');
    const auth = await attendanceAuth(this.opts, this.idToken, base);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${base}${pathAndQuery}`, {
        method,
        headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...auth },
        ...(json ? { body: JSON.stringify(json) } : {}),
        signal: ctl.signal,
      });
      if (res.status === 400 || res.status === 404 || res.status === 409) throw await upstreamError(res);
      if (!res.ok) throw new PresenceUnavailableError(`http_${res.status}`);
      return await res.json();
    } catch (err) {
      if (err instanceof PresenceUnavailableError || err instanceof PresenceReviewUpstreamError) throw err;
      throw new PresenceUnavailableError(ctl.signal.aborted ? 'timeout' : 'rede');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Só o `code` do corpo e só se estiver no conjunto fechado; senão, o código genérico do status. A mensagem do attendance nunca sai. */
async function upstreamError(res: Response): Promise<PresenceReviewUpstreamError> {
  const status = res.status as 400 | 404 | 409;
  const fallback = status === 409 ? 'EXCEPTION_ALREADY_DECIDED' : status === 404 ? 'EXCEPTION_NOT_FOUND' : 'BAD_REQUEST';
  try {
    const code = ((await res.json()) as { code?: unknown } | null)?.code;
    return new PresenceReviewUpstreamError(status, typeof code === 'string' && UPSTREAM_CODES.has(code) ? code : fallback);
  } catch {
    return new PresenceReviewUpstreamError(status, fallback);
  }
}

function toEntry(raw: unknown): ReviewQueueEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  const distance = nullableInt(r.distance_m);
  const accuracy = nullableInt(r.accuracy_m);
  const exceptionKind = r.exception_kind === 'GEO_DECLARED' || r.exception_kind === 'GEO_SERVER_DISAGREES' || r.exception_kind === null ? r.exception_kind : undefined;
  const slotOk = r.slot_id === null || isUuid(r.slot_id);
  const dateOk = r.on_date === null || (typeof r.on_date === 'string' && ISO_DATE.test(r.on_date));
  if (
    typeof r.kind !== 'string' || !KINDS.has(r.kind) || typeof r.id !== 'string' || r.id === '' || !isUuid(r.occurrence_id) || !isUuid(r.worker_id) || !slotOk || !dateOk ||
    typeof r.occurred_at !== 'string' || Number.isNaN(Date.parse(r.occurred_at)) || (r.reason !== null && typeof r.reason !== 'string') ||
    exceptionKind === undefined || distance === undefined || accuracy === undefined
  ) {
    throw new PresenceUnavailableError('resposta_invalida');
  }
  return {
    kind: r.kind as ReviewKind,
    id: r.id,
    occurrenceId: r.occurrence_id,
    workerId: r.worker_id,
    slotId: r.slot_id as string | null,
    onDate: r.on_date as string | null,
    occurredAt: r.occurred_at,
    reason: r.reason as string | null,
    exceptionKind,
    distanceM: distance,
    accuracyM: accuracy,
  };
}
