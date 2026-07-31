import { z } from 'zod';

/**
 * Data/hora da entrevista (encuadre) — SSOT de formato, fuso e resolução de fonte.
 *
 * Contexto (auditoria 30/07/2026): o sistema registrava QUE a entrevista foi agendada e
 * nunca QUANDO. As 9.214 datas no banco vieram todas da importação de 22-23/03/2026;
 * nenhuma origem do produto jamais gravou uma. `interview_datetime` estava em 0 de 13.046.
 */

/** Fuso da operação. A Enlite opera na Argentina — nunca usar o fuso do navegador. */
export const OPERATION_TIMEZONE = 'America/Argentina/Buenos_Aires';

/** Data no formato YYYY-MM-DD (o input de data do navegador já entrega assim). */
const interviewDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'interviewDate deve ser YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'interviewDate inválida');

/** Hora no formato HH:MM (24h), com segundos opcionais. */
const interviewTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'interviewTime deve ser HH:MM');

/**
 * Agendamento informado ao mover o card para "Agendados".
 *
 * Data e hora andam juntas: hora sem data não localiza a entrevista, e data sem hora não
 * permite lembrete nem marcação de falta. Ambas ausentes = "ainda não sei" (D4), que é um
 * caminho VÁLIDO — bloquear o movimento faria a recrutadora preencher qualquer coisa, e dado
 * inventado é pior que dado faltando.
 */
export const interviewScheduleSchema = z
  .object({
    interviewDate: interviewDateSchema.optional(),
    interviewTime: interviewTimeSchema.optional(),
    interviewMeetLink: z.string().url('interviewMeetLink deve ser uma URL').optional(),
  })
  .refine(
    (v) => (v.interviewDate == null) === (v.interviewTime == null),
    'interviewDate e interviewTime devem ser informadas juntas',
  );

export type InterviewSchedule = z.infer<typeof interviewScheduleSchema>;

/**
 * Expressão SQL que converte data+hora LOCAIS (parâmetros) no `timestamptz` correto.
 * A conversão é feita pelo Postgres, não em JS: sem dependência de biblioteca de fuso e
 * sem risco de o servidor de aplicação estar noutro fuso.
 *
 * @param dateParam índice do parâmetro da data  (ex.: '$3')
 * @param timeParam índice do parâmetro da hora  (ex.: '$4')
 */
export function interviewDatetimeSql(dateParam: string, timeParam: string): string {
  return `(${dateParam}::date + ${timeParam}::time) AT TIME ZONE '${OPERATION_TIMEZONE}'`;
}

/**
 * Resolução da data da entrevista a partir das DUAS fontes, em UM lugar só.
 *
 * `worker_job_applications.interview_datetime` é a fonte atual (timestamptz, consumida por
 * lembretes e no-show); `encuadres.interview_date` é o legado da importação. Ler só a nova
 * descartaria 9.219 registros históricos; ler só a legada mantém as automações mortas.
 *
 * Assume os aliases `wja` e `e`. Convertido para o fuso da OPERAÇÃO — não UTC: uma entrevista
 * às 21h de Buenos Aires é meia-noite em UTC e cairia no dia seguinte no relatório.
 */
export const INTERVIEW_DATE_RESOLVED_SQL = `COALESCE(
  (wja.interview_datetime AT TIME ZONE '${OPERATION_TIMEZONE}')::date,
  e.interview_date
)`;

export const INTERVIEW_TIME_RESOLVED_SQL = `COALESCE(
  (wja.interview_datetime AT TIME ZONE '${OPERATION_TIMEZONE}')::time,
  e.interview_time
)`;

/**
 * Início da semana corrente NO FUSO DA OPERAÇÃO (segunda-feira 00:00 em Buenos Aires),
 * como `timestamptz`. `date_trunc('week', CURRENT_DATE)` puro roda em UTC e faz o card
 * discordar do calendário de quem olha durante 3h toda madrugada de segunda.
 */
export const CURRENT_WEEK_START_SQL = `(date_trunc('week', (NOW() AT TIME ZONE '${OPERATION_TIMEZONE}')) AT TIME ZONE '${OPERATION_TIMEZONE}')`;
