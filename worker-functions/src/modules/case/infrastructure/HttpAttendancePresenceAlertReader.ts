import { PresenceUnavailableError } from '../application/ports/PresenceReaderPort';
import type { AttendancePresenceAlertReader, OpenPresenceRecord, RefusedWithoutEntryRecord } from '../application/ports/CoordinationAlertPorts';
import { attendanceAuth, googleIdTokenHeaders, presenceOptsFromEnv, type HttpPresenceReaderOpts, type IdTokenHeaders } from './HttpPresenceReader';

/** O job roda de 15 em 15 min fora de qualquer request do app: aguenta mais que o lookup do informe (2 s). */
const DEFAULT_TIMEOUT_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/**
 * Leitor do attendance para o alerta (emenda 077 §4.6): `GET /internal/v1/presence/open?on_date_from=` e
 * `GET /internal/v1/presence/refused-without-entry?since=`, arrays de topo, `Authorization: Bearer <ID token OIDC>`.
 * Mesma base, mesmo modo de auth (`ATTENDANCE_AUTH=none` só fora de produção) e mesma obtenção do ID token do `HttpPresenceReader`.
 * Qualquer falha → `PresenceUnavailableError` com código curto (o controller devolve 500 e o Scheduler re-tenta). Nunca loga corpo nem token.
 */
export class HttpAttendancePresenceAlertReader implements AttendancePresenceAlertReader {
  private readonly idToken: IdTokenHeaders;

  constructor(private readonly opts: HttpPresenceReaderOpts = presenceOptsFromEnv()) {
    this.idToken = opts.idToken ?? googleIdTokenHeaders();
  }

  async openPresence(onDateFrom: string): Promise<OpenPresenceRecord[]> {
    const rows = await this.get(`/internal/v1/presence/open?on_date_from=${encodeURIComponent(onDateFrom)}`);
    return rows.map((r) => {
      if (!isUuid(r.occurrence_id) || !isUuid(r.worker_id) || !isUuid(r.slot_id) || typeof r.on_date !== 'string' || !ISO_DATE.test(r.on_date)) {
        throw new PresenceUnavailableError('resposta_invalida');
      }
      return { occurrenceId: r.occurrence_id, workerId: r.worker_id, slotId: r.slot_id, onDate: r.on_date };
    });
  }

  async refusedWithoutEntry(since: Date): Promise<RefusedWithoutEntryRecord[]> {
    const rows = await this.get(`/internal/v1/presence/refused-without-entry?since=${encodeURIComponent(since.toISOString())}`);
    return rows.map((r) => {
      if (!isUuid(r.occurrence_id) || !isUuid(r.worker_id) || typeof r.first_refused_at !== 'string' || Number.isNaN(Date.parse(r.first_refused_at))) {
        throw new PresenceUnavailableError('resposta_invalida');
      }
      return { occurrenceId: r.occurrence_id, workerId: r.worker_id, firstRefusedAt: r.first_refused_at };
    });
  }

  private async get(pathAndQuery: string): Promise<Array<Record<string, unknown>>> {
    const base = this.opts.baseUrl?.replace(/\/+$/, '');
    if (!base) throw new PresenceUnavailableError('sem_url');
    const auth = await attendanceAuth(this.opts, this.idToken, base);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${base}${pathAndQuery}`, { method: 'GET', headers: auth, signal: ctl.signal });
      if (!res.ok) throw new PresenceUnavailableError(`http_${res.status}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new PresenceUnavailableError('resposta_invalida');
      return body as Array<Record<string, unknown>>;
    } catch (err) {
      if (err instanceof PresenceUnavailableError) throw err;
      throw new PresenceUnavailableError(ctl.signal.aborted ? 'timeout' : 'rede');
    } finally {
      clearTimeout(timer);
    }
  }
}
