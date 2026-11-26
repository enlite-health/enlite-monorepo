import { GoogleAuth } from 'google-auth-library';
import { PresenceUnavailableError, type PresenceReader, type PresenceStatus } from '../application/ports/PresenceReaderPort';

const DEFAULT_TIMEOUT_MS = 2_000;
const STATUSES: ReadonlySet<string> = new Set<PresenceStatus>(['NONE', 'OPEN', 'CLOSED', 'CLOSED_DECLARED']);

/** Quem entrega o header `Authorization` para o audience (o attendance, privado no Cloud Run). Injetável no teste. */
export type IdTokenHeaders = (audience: string) => Promise<Record<string, string>>;

/** ID token OIDC da SA do worker-functions (ADC), audience = URL do attendance. Mesmo padrão do `TriagePruebaClient`. */
export function googleIdTokenHeaders(): IdTokenHeaders {
  const auth = new GoogleAuth();
  return async (audience) => {
    const client = await auth.getIdTokenClient(audience);
    const h = await client.getRequestHeaders();
    return { Authorization: h.get('authorization') ?? '' };
  };
}

export interface HttpPresenceReaderOpts {
  /** `ATTENDANCE_SERVICE_URL` (base E audience do token). Ausente = fail-closed (503), nunca "presença fechada". */
  baseUrl?: string;
  /** `ATTENDANCE_PRESENCE_TIMEOUT_MS` (default 2000). */
  timeoutMs?: number;
  idToken?: IdTokenHeaders;
  fetchImpl?: typeof fetch;
}

export function presenceOptsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpPresenceReaderOpts {
  const t = Number(env.ATTENDANCE_PRESENCE_TIMEOUT_MS);
  return { baseUrl: env.ATTENDANCE_SERVICE_URL, ...(Number.isFinite(t) && t > 0 ? { timeoutMs: t } : {}) };
}

/**
 * `POST ${ATTENDANCE_SERVICE_URL}/internal/v1/presence/lookup` `{ occurrence_ids: [id] }` com `Authorization: Bearer <ID token OIDC>`.
 * Qualquer falha (sem URL, sem token, rede, timeout, não-2xx, corpo fora do contrato) → `PresenceUnavailableError` com código curto.
 */
export class HttpPresenceReader implements PresenceReader {
  private readonly idToken: IdTokenHeaders;

  constructor(private readonly opts: HttpPresenceReaderOpts = presenceOptsFromEnv()) {
    this.idToken = opts.idToken ?? googleIdTokenHeaders();
  }

  async statusOf(occurrenceId: string): Promise<PresenceStatus> {
    const base = this.opts.baseUrl?.replace(/\/+$/, '');
    if (!base) throw new PresenceUnavailableError('sem_url');

    let auth: Record<string, string>;
    try {
      auth = await this.idToken(base);
    } catch {
      throw new PresenceUnavailableError('sem_id_token');
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${base}/internal/v1/presence/lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ occurrence_ids: [occurrenceId] }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new PresenceUnavailableError(`http_${res.status}`);
      const body: unknown = await res.json();
      const row = Array.isArray(body) ? (body as Array<Record<string, unknown>>).find((r) => r?.occurrence_id === occurrenceId) : undefined;
      if (!row || typeof row.status !== 'string' || !STATUSES.has(row.status)) throw new PresenceUnavailableError('resposta_invalida');
      return row.status as PresenceStatus;
    } catch (err) {
      if (err instanceof PresenceUnavailableError) throw err;
      throw new PresenceUnavailableError(ctl.signal.aborted ? 'timeout' : 'rede');
    } finally {
      clearTimeout(timer);
    }
  }
}
