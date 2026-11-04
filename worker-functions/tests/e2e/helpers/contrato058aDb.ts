/**
 * contrato058aDb — fixtures de BANCO REAL das suítes `058a-*.e2e.test.ts` (spec 058, Parte A).
 *
 * Sem mock: tudo é SQL contra o Postgres do stack. Cada suíte usa o prefixo `QA058_` nos códigos de pagador e `T058A-` no `clickup_task_id` dos
 * pacientes, e limpa só o que é seu (o catálogo de 33 obras sociais e os demais pacientes não são tocados).
 */
import { Pool, PoolClient } from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

export const PREFIXO_PAGADOR = 'QA058_';
export const PREFIXO_PACIENTE = 'T058A-';

let seq = 0;
const unico = (): string => `${Date.now().toString(36)}${(seq++).toString(36)}`.toUpperCase();

export type PayerKind = 'OBRA_SOCIAL' | 'PREPAGA' | 'PRIVATE' | null;

/** Erro do pg com os campos que as asserções leem. */
export interface PgErr { code?: string; message: string; constraint?: string }

/** Roda `fn` e devolve o erro do pg (ou `null` se não houve erro). Nunca engole o resultado: quem chama decide. */
export async function erroDe(fn: () => Promise<unknown>): Promise<PgErr | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as PgErr;
  }
}

export function novoPool(): Pool {
  return new Pool({ connectionString: DATABASE_URL, max: 6 });
}

/** Cria um pagador de teste. `kind` null = não classificado. Devolve o `code`. */
export async function criarPagador(db: Pool | PoolClient, kind: PayerKind = 'OBRA_SOCIAL'): Promise<string> {
  const code = `${PREFIXO_PAGADOR}${unico()}`;
  await db.query(
    `INSERT INTO insurance_providers (code, name, sort_order, payer_kind)
     VALUES ($1, $2, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM insurance_providers), $3)`,
    [code, `QA058 ${code}`, kind],
  );
  return code;
}

export async function criarContrato(db: Pool | PoolClient, providerCode: string, country: 'AR' | 'BR' = 'AR'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO insurance_contracts (provider_code, country, name, created_by, updated_by)
     VALUES ($1, $2, $3, 'qa058a', 'qa058a') RETURNING id`,
    [providerCode, country, `contrato ${unico()}`],
  );
  return r.rows[0].id;
}

export async function criarPaciente(db: Pool | PoolClient, country: 'AR' | 'BR' = 'AR'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'QA058', 'Paciente QA', $2, 'ACTIVE') RETURNING id`,
    [`${PREFIXO_PACIENTE}${unico()}`, country],
  );
  return r.rows[0].id;
}

export async function criarServico(db: Pool | PoolClient, patientId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO patient_contracted_services (patient_id, service_code, active, created_by, updated_by)
     VALUES ($1, 'CAREGIVER', true, 'qa058a', 'qa058a') RETURNING id`,
    [patientId],
  );
  return r.rows[0].id;
}

/** `[desde,até)` como texto de daterange; `ate` omitido = sem fim. */
export const vigencia = (desde: string, ate?: string): string => `[${desde},${ate ?? ''})`;

export async function vincular(
  db: Pool | PoolClient, serviceId: string, contractId: string, valid: string,
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO contracted_service_contract (contracted_service_id, contract_id, valid, recorded_by)
     VALUES ($1, $2, $3::daterange, 'qa058a') RETURNING id`,
    [serviceId, contractId, valid],
  );
  return r.rows[0].id;
}

/** Marca a linha (o escritor só informa por/razão; `superseded_at` e `superseded_xact` são do banco). */
export async function marcar(db: Pool | PoolClient, linkId: string, reason: 'ENDED' | 'SWITCHED' | 'CORRECTION'): Promise<void> {
  await db.query(
    `UPDATE contracted_service_contract SET superseded_by = 'qa058a', superseded_reason = $2 WHERE id = $1`,
    [linkId, reason],
  );
}

/** Roda `fn` numa transação com cliente próprio e comita (ou reverte se `fn` lançar). */
export async function emTransacao<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Roda `fn` numa transação e REVERTE sempre (para provar recusas sem deixar rastro, mesmo se a trava faltar). */
export async function emTransacaoRevertida<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/**
 * Limpa o que as suítes 058a criaram. `session_replication_role = replica` desliga os triggers de imutabilidade/rastro
 * (só no superusuário do banco de teste) para o DELETE passar; a ordem respeita as FKs.
 */
export async function limpar(pool: Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    const pagadores = `SELECT code FROM insurance_providers WHERE code LIKE '${PREFIXO_PAGADOR}%'`;
    const pacientes = `SELECT id FROM patients WHERE clickup_task_id LIKE '${PREFIXO_PACIENTE}%'`;
    await c.query(`DELETE FROM contracted_service_contract WHERE contracted_service_id IN
                     (SELECT id FROM patient_contracted_services WHERE patient_id IN (${pacientes}))
                      OR contract_id IN (SELECT id FROM insurance_contracts WHERE provider_code IN (${pagadores}))`);
    await c.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (${pacientes})`);
    await c.query(`DELETE FROM patients WHERE id IN (${pacientes})`);
    await c.query(`DELETE FROM insurance_contract_terms WHERE contract_id IN
                     (SELECT id FROM insurance_contracts WHERE provider_code IN (${pagadores}))`);
    await c.query(`DELETE FROM insurance_contracts WHERE provider_code IN (${pagadores})`);
    await c.query(`DELETE FROM insurance_provider_contacts WHERE provider_code IN (${pagadores})`);
    await c.query(`DELETE FROM insurance_provider_payer_kind_history WHERE provider_code LIKE '${PREFIXO_PAGADOR}%'`);
    await c.query(`DELETE FROM insurance_providers WHERE code LIKE '${PREFIXO_PAGADOR}%'`);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
