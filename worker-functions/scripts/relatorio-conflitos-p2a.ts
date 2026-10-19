/**
 * relatorio-conflitos-p2a.ts — as 6 queries Q1–Q6 do P2(A) (spec 058 Parte A, plan §3.3, T031).
 *
 * O P2(A) é o PR que dá DROP nas 6 colunas legadas da cobertura/contrato. Ele só pode sair quando as 6 contagens abaixo derem 0 — e a
 * migration do DROP repete as mesmas 6 queries com `assert = 0` dentro dela. Este script é a ferramenta do Gabriel para ver o tamanho do
 * trabalho ANTES (quais serviços/pacientes ainda divergem do dono novo).
 *
 *   Q1  pcs.hourly_value        <> termo vigente (hourly_rate) em $asof, ou serviço sem vínculo vivo
 *   Q2  pcs.tax_condition       <> termo vigente (tax_rate_percent) em $asof, ou sem vínculo vivo   — mapa rate(...) SÓ AQUI
 *   Q3  pcs.contract_type       <> payer_kind do pagador do contrato vinculado, ou sem vínculo vivo
 *   Q4  patients.insurance_verified   <> raw_label do ordinal 1 E source = 'clickup' de patient_insurance_verified
 *   Q5  patients.health_insurance_name        <> patients.insurance_informed   (N(x) nos DOIS lados)
 *   Q6  patients.health_insurance_member_id   <> patients.affiliate_id         (N(x) nos DOIS lados)
 *
 * N(x) = NULLIF(NULLIF(lower(btrim(x)), ''), 'null') — o mesmo normalizador do backfill da migration 539 (R4): "null", vazio e só-espaço
 * valem "ausente". Em Q4 só `source = 'clickup'` entra (o legado veio do ClickUp; linhas `admin_manual` não contam). Sem filtro de `deleted_at`.
 *
 * SÓ LEITURA E SÓ CONTAGEM: uma transação READ ONLY, uma query por Q, `count(*)` e nada mais — nenhuma linha de paciente sai do banco, nenhum
 * valor aparece na saída. Erro: imprime só `code` e a 1ª linha da mensagem (equivalente ao VERBOSITY terse do psql: o DETAIL do pg ecoaria a linha).
 * `$asof` é a DATA LOCAL do país do serviço (AR e BR têm fuso próprio); leitura única aqui, fora de qualquer trigger/regra de domínio.
 *
 * Uso:  DATABASE_URL=… npx ts-node scripts/relatorio-conflitos-p2a.ts [--asof AAAA-MM-DD]
 */
import { Pool } from 'pg';
import { countryToTimezone } from '../src/shared/locale/CountryTimezone';

/** Normalizador único N(x) — texto SQL. Usado nos dois lados de Q4/Q5/Q6. */
export const N = (expr: string): string => `NULLIF(NULLIF(lower(btrim(${expr})), ''), 'null')`;

/** Mapa tax_condition -> percentual. Existe SÓ neste script (leitura única, sem leitor de produto). */
export const RATE_SQL = `CASE s.tax_condition WHEN 'IVA_EXEMPT' THEN 0 WHEN 'IVA_10_5' THEN 10.5 WHEN 'IVA_21' THEN 21 END`;

/** $1 = data local AR, $2 = data local BR; a data de referência do serviço depende do país dele. */
const ASOF = `(CASE s.country WHEN 'AR' THEN $1::date WHEN 'BR' THEN $2::date END)`;

/** Vínculo vivo do serviço em $asof, com o termo vigente do contrato (e, opcionalmente, o pagador). */
const VINCULO_VIVO = `
    FROM contracted_service_contract l
    JOIN insurance_contract_terms t ON t.contract_id = l.contract_id AND t.superseded_at IS NULL AND t.valid @> ${ASOF}
    JOIN insurance_contracts c ON c.id = l.contract_id
    JOIN insurance_providers p ON p.code = c.provider_code
   WHERE l.contracted_service_id = s.id AND l.superseded_at IS NULL AND l.valid @> ${ASOF}`;

export interface ConsultaConflito { id: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6'; titulo: string; usaAsof: boolean; sql: string }

/** Conflito de texto entre o legado e o dono, com N(x) nos DOIS lados. */
export const sqlConflitoTexto = (legado: string, dono: string): string =>
  `SELECT count(*)::int AS n FROM patients p
    WHERE ${N(legado)} IS NOT NULL AND ${N(legado)} IS DISTINCT FROM ${N(dono)}`;

export const CONSULTAS: readonly ConsultaConflito[] = [
  {
    id: 'Q1', titulo: 'pcs.hourly_value sem vínculo vivo ou diferente do hourly_rate do termo vigente', usaAsof: true,
    sql: `SELECT count(*)::int AS n FROM patient_contracted_services s
           WHERE s.hourly_value IS NOT NULL
             AND NOT EXISTS (SELECT 1 ${VINCULO_VIVO} AND t.hourly_rate = s.hourly_value)`,
  },
  {
    id: 'Q2', titulo: 'pcs.tax_condition sem vínculo vivo ou diferente do tax_rate_percent do termo vigente (rate())', usaAsof: true,
    sql: `SELECT count(*)::int AS n FROM patient_contracted_services s
           WHERE s.tax_condition IS NOT NULL
             AND NOT EXISTS (SELECT 1 ${VINCULO_VIVO} AND t.tax_rate_percent = ${RATE_SQL})`,
  },
  {
    id: 'Q3', titulo: 'pcs.contract_type sem vínculo vivo ou diferente do payer_kind do pagador', usaAsof: true,
    sql: `SELECT count(*)::int AS n FROM patient_contracted_services s
           WHERE s.contract_type IS NOT NULL
             AND NOT EXISTS (SELECT 1 ${VINCULO_VIVO} AND p.payer_kind = s.contract_type)`,
  },
  {
    id: 'Q4', titulo: "patients.insurance_verified diferente do raw_label do ordinal 1 com source = 'clickup'", usaAsof: false,
    sql: `SELECT count(*)::int AS n FROM patients p
           WHERE ${N('p.insurance_verified')} IS NOT NULL
             AND ${N('p.insurance_verified')} IS DISTINCT FROM ${N(
               `(SELECT v.raw_label FROM patient_insurance_verified v WHERE v.patient_id = p.id AND v.ordinal = 1 AND v.source = 'clickup')`)}`,
  },
  {
    id: 'Q5', titulo: 'patients.health_insurance_name diferente de insurance_informed (N nos dois lados)', usaAsof: false,
    sql: sqlConflitoTexto('p.health_insurance_name', 'p.insurance_informed'),
  },
  {
    id: 'Q6', titulo: 'patients.health_insurance_member_id diferente de affiliate_id (N nos dois lados)', usaAsof: false,
    sql: sqlConflitoTexto('p.health_insurance_member_id', 'p.affiliate_id'),
  },
];

/** Data local (AAAA-MM-DD) do país `country` no instante `now`. */
export function dataLocal(country: 'AR' | 'BR', now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: countryToTimezone(country), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export interface LinhaRelatorio { id: string; titulo: string; conflitos: number }

/** Roda as 6 queries numa única transação READ ONLY e devolve só as contagens. */
export async function executarRelatorio(
  pool: Pick<Pool, 'connect'>, asof?: { ar: string; br: string },
): Promise<LinhaRelatorio[]> {
  const ref = asof ?? { ar: dataLocal('AR', new Date()), br: dataLocal('BR', new Date()) };
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const linhas: LinhaRelatorio[] = [];
    for (const q of CONSULTAS) {
      const r = await client.query<{ n: number }>(q.sql, q.usaAsof ? [ref.ar, ref.br] : []);
      linhas.push({ id: q.id, titulo: q.titulo, conflitos: r.rows[0].n });
    }
    await client.query('ROLLBACK');
    return linhas;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--asof');
  const asof = i >= 0 ? { ar: process.argv[i + 1], br: process.argv[i + 1] } : undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const linhas = await executarRelatorio(pool, asof);
    for (const l of linhas) console.log(`${l.id}\t${l.conflitos}\t${l.titulo}`);
    console.log(`TOTAL\t${linhas.reduce((a, l) => a + l.conflitos, 0)}`);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error(`erro ${err.code ?? ''}: ${(err.message ?? '').split('\n')[0]}`); // nunca err.detail: ecoaria a linha
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) void main();
