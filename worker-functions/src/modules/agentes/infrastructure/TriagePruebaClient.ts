import { GoogleAuth } from 'google-auth-library';
import {
  TriageIndisponivel,
  type PruebaTurnoEntrada,
  type PruebaTurnoSaida,
  type TriagePruebaPort,
} from '../domain/TriagePruebaPort';

const TIMEOUT_MS = 60_000;
const TIPOS = new Set(['reply', 'handover_simulado', 'skip']);

/** Quem entrega o header `Authorization` para o audience (o triage Cloud Run). Injetável no teste. */
export type IdTokenHeaders = (audience: string) => Promise<Record<string, string>>;

/** ID token OIDC da SA do worker-functions (ADC), audience = URL do triage. O `GoogleAuth` é um só, mas `getIdTokenClient(audience)` é chamado a CADA turno (o cache de token, se houver, é o da biblioteca). */
export function googleIdTokenHeaders(): IdTokenHeaders {
  const auth = new GoogleAuth();
  return async (audience) => {
    const client = await auth.getIdTokenClient(audience);
    const h = await client.getRequestHeaders();
    return { Authorization: h.get('authorization') ?? '' };
  };
}

export interface TriagePruebaClientOpts {
  /** `TRIAGE_PRUEBA_URL`. Ausente = fail-closed (TriageIndisponivel). */
  baseUrl?: string;
  /** `TRIAGE_PRUEBA_AUTH=none` só vale fora de produção (e2e/CI sem credencial GCP). Nunca é o default. */
  authNone?: boolean;
  idToken?: IdTokenHeaders;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Lê as envs. `TRIAGE_PRUEBA_AUTH=none` é IGNORADO com NODE_ENV=production (a SA é obrigatória lá). */
export function triagePruebaOptsFromEnv(env: NodeJS.ProcessEnv = process.env): TriagePruebaClientOpts {
  return {
    baseUrl: env.TRIAGE_PRUEBA_URL,
    authNone: env.TRIAGE_PRUEBA_AUTH === 'none' && env.NODE_ENV !== 'production',
  };
}

/**
 * `POST ${TRIAGE_PRUEBA_URL}/internal/luz/prueba/turn` com `Authorization: Bearer <ID token, audience = TRIAGE_PRUEBA_URL>`
 * (o lado que EMITE do par `ServiceIdentityVerifier`) e `x-enlite-gatilho-id: prueba:<uid>:<sessao>#turno-<N>`.
 * Nunca loga corpo, texto nem resposta: a causa da falha sai como código curto.
 */
export class TriagePruebaClient implements TriagePruebaPort {
  private readonly idToken: IdTokenHeaders;

  constructor(private readonly opts: TriagePruebaClientOpts) {
    this.idToken = opts.idToken ?? googleIdTokenHeaders();
  }

  async turno(e: PruebaTurnoEntrada): Promise<PruebaTurnoSaida> {
    const base = this.opts.baseUrl?.replace(/\/+$/, '');
    if (!base) throw new TriageIndisponivel('sem_url');

    let auth: Record<string, string> = {};
    if (!this.opts.authNone) {
      try {
        auth = await this.idToken(base);
      } catch {
        throw new TriageIndisponivel('sem_id_token');
      }
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? TIMEOUT_MS);
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${base}/internal/luz/prueba/turn`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-enlite-gatilho-id': `prueba:${e.uid}:${e.sessao}#turno-${e.turno}`,
          ...auth,
        },
        body: JSON.stringify({ uid: e.uid, sessao: e.sessao, mensagem: e.mensagem, historico: e.historico }),
        signal: ctl.signal,
      });
    } catch (err) {
      throw new TriageIndisponivel(ctl.signal.aborted ? 'timeout' : 'rede');
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new TriageIndisponivel(`http_${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TriageIndisponivel('resposta_invalida');
    }
    if (!formatoValido(body)) throw new TriageIndisponivel('resposta_invalida');
    return body;
  }
}

function formatoValido(b: unknown): b is PruebaTurnoSaida {
  if (typeof b !== 'object' || b === null) return false;
  const o = b as Record<string, unknown>;
  const p = o.prestadora as Record<string, unknown> | undefined;
  return (
    typeof o.tipo === 'string' && TIPOS.has(o.tipo) &&
    Array.isArray(o.ferramentas) && Array.isArray(o.validadores) &&
    typeof p === 'object' && p !== null && typeof p.nome === 'string'
  );
}
