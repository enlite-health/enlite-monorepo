import { Pool } from 'pg';

export interface TalentumWebhookHealth {
  /** FAILED (sempre) + REJECTED_SCHEMA / UNSUPPORTED recebidas nas últimas `INBOX_FALHA_JANELA_HORAS`. */
  inbox_falha: number;
  /** Linhas RECEIVED há mais de `INBOX_PENDENTE_MINUTOS` sem processar. */
  inbox_pendente: number;
  /** Espelho COMPLETED há mais de `VEREDITO_AUSENTE_HORAS` sem veredito chegar. */
  veredito_ausente: number;
  /** 1 se, dentro do horário comercial AR, a inbox ficou 0 linhas nas últimas `SILENCIO_HORAS`; senão 0. */
  silencio: number;
}

/** N da decisão 1 (confirmado pela medição P3): tempo máximo entre COMPLETED e o veredito. */
export const VEREDITO_AUSENTE_HORAS = 2;
export const INBOX_PENDENTE_MINUTOS = 15;
export const SILENCIO_HORAS = 6;
export const SILENCIO_TIMEZONE = 'America/Argentina/Buenos_Aires';
/** Janela (hora local, [início, fim)) em que o silêncio da inbox é anormal. */
export const SILENCIO_HORA_INICIO = 9;
export const SILENCIO_HORA_FIM = 21;

/** Estados de erro da inbox. */
export const INBOX_ESTADOS_FALHA: readonly string[] = ['FAILED', 'REJECTED_SCHEMA', 'UNSUPPORTED'];
/** FAILED é acionável (redrive): conta enquanto existir, sem corte de idade. */
export const INBOX_FALHA_SEM_CORTE: readonly string[] = ['FAILED'];
/** UNSUPPORTED / REJECTED_SCHEMA não têm redrive que os limpe: só alarmam nesta janela, senão o alarme é eterno. */
export const INBOX_FALHA_COM_CORTE: readonly string[] = ['REJECTED_SCHEMA', 'UNSUPPORTED'];
export const INBOX_FALHA_JANELA_HORAS = 24;
/** Único status do espelho que conta como "veredito ausente". IN_PROGRESS (abandono) NUNCA entra. */
export const ESPELHO_STATUS_SEM_VEREDITO: readonly string[] = ['COMPLETED'];

/** Hora (0-23) em `timeZone`, calculada por Intl — independe do TZ do processo. */
export function hourInZone(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now);
  return Number(h);
}

/**
 * Diagnóstico read-only do webhook do Talentum (spec 095 F4, T-095-40) — predicado de ESTADO, molde
 * `ItineraryDailyRunHealthService`: continua verdadeiro enquanto o problema existir. Zero escrita, sem PII: só contagens.
 * `now` entra como parâmetro SQL (não `now()` do banco) para o relógio falso valer.
 */
export class TalentumWebhookHealthService {
  constructor(private readonly pool: Pool) {}

  async getHealth(now: Date = new Date()): Promise<TalentumWebhookHealth> {
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const count = async (sql: string, params: unknown[]): Promise<number> => {
      const { rows } = await this.pool.query<{ n: number | string }>(sql, params);
      return Number(rows[0]?.n ?? 0);
    };

    const inbox_falha = await count(
      'SELECT count(*)::int AS n FROM talentum_webhook_inbox WHERE state = ANY($1::text[]) OR (state = ANY($2::text[]) AND received_at >= $3)',
      [INBOX_FALHA_SEM_CORTE, INBOX_FALHA_COM_CORTE, ago(INBOX_FALHA_JANELA_HORAS * 3_600_000)],
    );
    const inbox_pendente = await count(
      'SELECT count(*)::int AS n FROM talentum_webhook_inbox WHERE state = $1 AND received_at < $2',
      ['RECEIVED', ago(INBOX_PENDENTE_MINUTOS * 60_000)],
    );
    const veredito_ausente = await count(
      'SELECT count(*)::int AS n FROM talentum_prescreenings WHERE status = ANY($1::text[]) AND updated_at < $2',
      [ESPELHO_STATUS_SEM_VEREDITO, ago(VEREDITO_AUSENTE_HORAS * 3_600_000)],
    );

    const hora = hourInZone(now, SILENCIO_TIMEZONE);
    let silencio = 0;
    if (hora >= SILENCIO_HORA_INICIO && hora < SILENCIO_HORA_FIM) {
      const recentes = await count(
        'SELECT count(*)::int AS n FROM talentum_webhook_inbox WHERE received_at >= $1',
        [ago(SILENCIO_HORAS * 3_600_000)],
      );
      silencio = recentes === 0 ? 1 : 0;
    }
    return { inbox_falha, inbox_pendente, veredito_ausente, silencio };
  }
}
