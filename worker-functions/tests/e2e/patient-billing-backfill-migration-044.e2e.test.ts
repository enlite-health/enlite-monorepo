import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * Régua das migrations 500/501 (spec 044, D475): faturamento do paciente + backfill = Principal; trilha da remoção
 * de Localización sem texto; célula `patient_address:delete`.
 *
 * Lê os arquivos do disco (molde `patient-status-suspended-exit-reason-migration.e2e.test.ts`): `readFileSync` + query,
 * não o runner — só assim o backfill (A11/A12) e o `down` são exercitados com dado semeado. Tudo que escreve roda num
 * client dedicado dentro de BEGIN … ROLLBACK: o banco do teste volta como estava.
 *
 * O backfill é o `UPDATE patients p …` do FIM de `500_*.sql` (extraído do arquivo, não copiado aqui): se alguém mexer no
 * SQL da migration, é este SQL que o teste executa. Endereços de ficção.
 */

const MIG_DIR = join(__dirname, '..', '..', 'migrations');
const UP_500 = readFileSync(join(MIG_DIR, '500_patient_billing_address.sql'), 'utf8');
const DOWN_500 = readFileSync(join(MIG_DIR, 'pending', 'ROLLBACK_500_patient_billing_address.sql'), 'utf8');
const BACKFILL = UP_500.slice(UP_500.indexOf('UPDATE patients p'));

const BILLING_COLS = ['billing_address_formatted', 'billing_city', 'billing_province'];

async function colunasBilling(q: Pool | PoolClient): Promise<Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>> {
  const { rows } = await q.query(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'patients' AND column_name = ANY($1) ORDER BY column_name`,
    [BILLING_COLS],
  );
  return rows;
}

describe('migrations 500/501 — faturamento + backfill + trilha da remoção (banco real) @integration', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('o recorte do backfill é de fato o UPDATE (controle: o arquivo tem o marcador e o recorte começa nele)', () => {
    expect(UP_500.indexOf('UPDATE patients p')).toBeGreaterThan(0);
    expect(BACKFILL.startsWith('UPDATE patients p')).toBe(true);
    expect(BACKFILL).toContain('pa.is_default');
  });

  it('500: 3 colunas text, nullable, sem default', async () => {
    const cols = await colunasBilling(pool);
    expect(cols.map((c) => c.column_name)).toEqual(BILLING_COLS.slice().sort());
    for (const c of cols) {
      expect(c.data_type).toBe('text');
      expect(c.is_nullable).toBe('YES');
      expect(c.column_default).toBeNull();
    }
  });

  describe('backfill (A11/A12) — semeado dentro de BEGIN … ROLLBACK', () => {
    let client: PoolClient;
    const ids: Record<string, string> = {};

    async function paciente(chave: string, extra: { billing?: string; deleted?: boolean } = {}): Promise<string> {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, country, status, billing_address_formatted, deleted_at, updated_at)
         VALUES ($1, 'AR', 'ACTIVE', $2, ${extra.deleted ? 'NOW()' : 'NULL'}, '2020-01-01T00:00:00Z') RETURNING id`,
        [`e2e-500-${chave}-${Date.now()}`, extra.billing ?? null],
      );
      ids[chave] = rows[0].id;
      return rows[0].id;
    }
    async function endereco(patientId: string, o: { order: number; principal?: boolean; arquivado?: boolean; formatted?: string | null; raw?: string | null; city?: string | null; state?: string | null }): Promise<void> {
      await client.query(
        `INSERT INTO patient_addresses (patient_id, address_type, address_formatted, address_raw, city, state, is_default, display_order, archived_at, country)
         VALUES ($1, 'domicilio_propio', $2, $3, $4, $5, $6, $7, ${o.arquivado ? 'NOW()' : 'NULL'}, 'AR')`,
        [patientId, o.formatted ?? null, o.raw ?? null, o.city ?? null, o.state ?? null, o.principal ?? false, o.order],
      );
    }
    const billingDe = async (chave: string) =>
      (await client.query(
        `SELECT billing_address_formatted AS f, billing_city AS c, billing_province AS p, updated_at FROM patients WHERE id = $1`,
        [ids[chave]],
      )).rows[0];

    beforeAll(async () => {
      client = await pool.connect();
      await client.query('BEGIN');

      // A11: o 1º por display_order NÃO é o Principal — tem de copiar o Principal.
      const a = await paciente('principal-nao-e-o-primeiro');
      await endereco(a, { order: 1, formatted: 'Calle Primera 1, Ficticia', city: 'Ciudad Primera', state: 'Provincia Primera' });
      await endereco(a, { order: 2, principal: true, formatted: 'Calle Principal 2, Ficticia', city: 'Ciudad Principal', state: 'Provincia Principal' });

      // A11: Principal ARQUIVADO é ignorado (o ativo não-Principal também não entra) → fica NULL.
      const b = await paciente('principal-arquivado');
      await endereco(b, { order: 1, principal: true, arquivado: true, formatted: 'Calle Arquivada 3, Ficticia', city: 'Ciudad Arquivada', state: 'Provincia Arquivada' });
      await endereco(b, { order: 2, formatted: 'Calle Ativa 4, Ficticia' });

      // A12: faturamento já preenchido não é sobrescrito.
      const c = await paciente('ja-preenchido', { billing: 'Faturamento Pre Existente 5' });
      await endereco(c, { order: 1, principal: true, formatted: 'Calle Principal 6, Ficticia', city: 'Ciudad Seis', state: 'Provincia Seis' });

      // A12: sem Principal → NULL.
      const d = await paciente('sem-principal');
      await endereco(d, { order: 1, formatted: 'Calle Sem Principal 7, Ficticia' });

      // COALESCE(formatted, raw): Principal só com texto cru entra pelo cru.
      const e = await paciente('so-raw');
      await endereco(e, { order: 1, principal: true, formatted: null, raw: 'calle solo raw 8', city: null, state: null });

      // Principal sem texto nenhum (ambos NULL) → fica NULL (cidade/província sozinhas não viram faturamento).
      const f = await paciente('sem-texto');
      await endereco(f, { order: 1, principal: true, formatted: null, raw: null, city: 'Ciudad Solta', state: 'Provincia Solta' });

      // Paciente apagado (deleted_at) → não copia PII.
      const g = await paciente('apagado', { deleted: true });
      await endereco(g, { order: 1, principal: true, formatted: 'Calle Apagado 9, Ficticia', city: 'Ciudad Nove', state: 'Provincia Nove' });

      await client.query(BACKFILL);
    });

    afterAll(async () => {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    });

    it('A11: copia o Principal (texto, cidade, província) — não o addresses[0] por display_order', async () => {
      expect(await billingDe('principal-nao-e-o-primeiro')).toMatchObject({
        f: 'Calle Principal 2, Ficticia', c: 'Ciudad Principal', p: 'Provincia Principal',
      });
    });

    it('A11: Principal arquivado é ignorado — fica NULL, mesmo havendo outro endereço ativo', async () => {
      expect(await billingDe('principal-arquivado')).toMatchObject({ f: null, c: null, p: null });
    });

    it('A12: faturamento já preenchido NÃO é sobrescrito (texto, cidade e província intactos)', async () => {
      expect(await billingDe('ja-preenchido')).toMatchObject({ f: 'Faturamento Pre Existente 5', c: null, p: null });
    });

    it('A12: paciente sem Principal fica NULL', async () => {
      expect(await billingDe('sem-principal')).toMatchObject({ f: null, c: null, p: null });
    });

    it('COALESCE(formatted, raw): Principal só com texto cru entra pelo cru; cidade/província NULL seguem NULL', async () => {
      expect(await billingDe('so-raw')).toMatchObject({ f: 'calle solo raw 8', c: null, p: null });
    });

    it('Principal sem texto algum não vira faturamento (nem só com cidade/província)', async () => {
      expect(await billingDe('sem-texto')).toMatchObject({ f: null, c: null, p: null });
    });

    it('paciente apagado (deleted_at) não recebe a cópia', async () => {
      expect(await billingDe('apagado')).toMatchObject({ f: null, c: null, p: null });
    });

    it('não toca updated_at (continua o valor semeado de 2020)', async () => {
      const r = await billingDe('principal-nao-e-o-primeiro');
      expect(new Date(r.updated_at).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    });

    it('A12: rodar o UPDATE 2× dá o mesmo resultado (idempotente) e a 2ª rodada não altera nenhuma linha', async () => {
      const antes = await Promise.all(Object.keys(ids).map(async (k) => [k, await billingDe(k)] as const));
      const segunda = await client.query(BACKFILL);
      const depois = await Promise.all(Object.keys(ids).map(async (k) => [k, await billingDe(k)] as const));
      expect(depois).toEqual(antes);
      // As linhas desta suíte que ainda têm billing NULL e Principal com texto = 0 (todas as elegíveis já foram preenchidas).
      const elegiveisRestantes = await client.query(
        `SELECT count(*)::int AS n FROM patients p JOIN patient_addresses pa ON pa.patient_id = p.id
          WHERE p.id = ANY($1) AND pa.is_default AND pa.archived_at IS NULL AND p.billing_address_formatted IS NULL
            AND p.deleted_at IS NULL AND COALESCE(pa.address_formatted, pa.address_raw) IS NOT NULL`,
        [Object.values(ids)],
      );
      expect(elegiveisRestantes.rows[0].n).toBe(0);
      expect(segunda.command).toBe('UPDATE');
    });

    it('controle positivo: a 1ª rodada de fato escreveu (3 pacientes elegíveis com billing preenchido)', async () => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM patients WHERE id = ANY($1) AND billing_address_formatted IS NOT NULL`,
        [Object.values(ids)],
      );
      // principal-nao-e-o-primeiro, ja-preenchido (pré-existente) e so-raw
      expect(rows[0].n).toBe(3);
    });
  });

  it('500: o down dropa as 3 colunas (dentro de transação que volta) e é idempotente', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(DOWN_500);
      const depoisDoDown = await colunasBilling(client);
      await client.query(DOWN_500);
      await client.query('ROLLBACK');
      expect(depoisDoDown).toHaveLength(0);
      expect(await colunasBilling(pool)).toHaveLength(3);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('501: patient_address_audit_log existe e NÃO tem coluna de texto de endereço', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'patient_address_audit_log'`,
    );
    const nomes = rows.map((r) => r.column_name);
    expect(nomes).toEqual(expect.arrayContaining(['id', 'patient_id', 'event_type', 'changes', 'actor_user_id', 'actor_type', 'trace_id', 'created_at']));
    expect(nomes.filter((n) => /address_formatted|address_raw|complement|access_notes|^lat$|^lng$/.test(n))).toEqual([]);
  });

  it('501: a célula patient_address:delete existe no catálogo (o grant aos grupos de update é conferido na F0/na stage; grupos de outras suítes mudam depois da migration)', async () => {
    const { rows } = await pool.query(`SELECT id FROM iam.permissions WHERE resource = 'patient_address' AND action = 'delete'`);
    expect(rows).toHaveLength(1);
  });
});
