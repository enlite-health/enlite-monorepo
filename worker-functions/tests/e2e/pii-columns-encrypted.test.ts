/**
 * Invariante de CATÁLOGO (lex 08/09, sugestão ao fechar a D301): "KMS" era costume, não regra — nada no CI
 * impedia uma tabela nova de nascer com telefone em claro (a 1ª versão da migration 417 nasceu assim e só o
 * parecer pegou). Este teste lê o schema REAL e reprova qualquer coluna de contato/documento em claro em
 * `patients` e em toda tabela com FK para `patients` — irmão do `country-rls-policies` (toda satélite tem RLS).
 *
 * A lista de EXCEÇÕES é explícita e NOMEADA: são as colunas que já existiam em claro antes da regra, cada uma
 * com o motivo. Coluna nova em claro entra aqui só com parecer do `lex` — e o diff mostra.
 */
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/** O que parece contato/documento pelo NOME da coluna. */
const PARECE_PII = /(phone|telefono|email|e_mail|document_number|documento|dni|cpf|cuil)/;
/** O que já está protegido ou não é o valor: cifrado, blind index, hash, máscara, tipo, flags e datas. */
const PROTEGIDO_OU_NAO_VALOR = /(_encrypted|_enc$|_bidx|_hash|_masked|_type$|_verified|_confirmed|_status|_at$|matches)/;

/** Dívida herdada, nomeada — NÃO cresce sem parecer. */
const EXCECOES_HERDADAS: ReadonlyArray<{ tabela: string; coluna: string; porque: string }> = [
  { tabela: 'patients', coluna: 'document_number', porque: 'documento do paciente em claro desde o cadastro inicial; busca por documento na lista (D286: só com patient_identity:read). Cifrar exige blind index — LISTA.' },
  { tabela: 'patients', coluna: 'phone_whatsapp', porque: 'telefone do paciente em claro desde o cadastro inicial; casa com o do responsável (phoneMatchesResponsible). Cifrar exige blind index — LISTA.' },
  { tabela: 'admission_appointments', coluna: 'host_email', porque: 'e-mail do STAFF anfitrião do compromisso (colaborador, não titular-paciente).' },
];

describe('invariante: coluna de contato/documento em claro em patients e satélites (schema real)', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  it('🔒 nenhuma coluna de telefone/e-mail/documento em claro fora das exceções herdadas — e cada exceção ainda existe (lista não envelhece)', async () => {
    const { rows } = await pool.query<{ tabela: string; coluna: string }>(`
      WITH satelites AS (
        SELECT DISTINCT c.conrelid::regclass::text AS tabela
          FROM pg_constraint c
         WHERE c.contype = 'f' AND c.confrelid = 'public.patients'::regclass
        UNION SELECT 'patients'
      )
      SELECT replace(s.tabela, 'public.', '') AS tabela, col.column_name AS coluna
        FROM satelites s
        JOIN information_schema.columns col
          ON col.table_schema = 'public' AND col.table_name = replace(s.tabela, 'public.', '')
       ORDER BY 1, 2`);
    expect(rows.length).toBeGreaterThan(50); // contagem zero seria "não olhei", não "está limpo"

    const emClaro = rows
      .filter((r) => PARECE_PII.test(r.coluna) && !PROTEGIDO_OU_NAO_VALOR.test(r.coluna))
      .map((r) => `${r.tabela}.${r.coluna}`);
    const permitidas = EXCECOES_HERDADAS.map((e) => `${e.tabela}.${e.coluna}`);
    const novas = emClaro.filter((c) => !permitidas.includes(c));
    expect(novas).toEqual([]); // coluna nova em claro: cifre (molde patient_responsibles/136, 417) ou traga parecer

    // A exceção que sumir do schema sai da lista — regra que aponta para coluna morta é regra morta.
    const mortas = permitidas.filter((c) => !emClaro.includes(c));
    expect(mortas).toEqual([]);

    // Controle positivo do detector (D157): a tabela da 417 tem o telefone CIFRADO e o detector a vê como protegida.
    const contatos = rows.filter((r) => r.tabela === 'patient_coverage_emergency_contacts').map((r) => r.coluna);
    expect(contatos).toContain('phone_encrypted'); // a 417 está na árvore: o controle é incondicional
    expect(contatos.filter((c) => PARECE_PII.test(c) && !PROTEGIDO_OU_NAO_VALOR.test(c))).toEqual([]);
  });

  it('controle positivo: um telefone em claro numa satélite temporária é DETECTADO (o detector mede, não só passa)', async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS pii_probe_tmp (id serial PRIMARY KEY, patient_id uuid REFERENCES patients(id) ON DELETE CASCADE, phone text)`);
    try {
      const { rows } = await pool.query<{ coluna: string }>(`SELECT column_name AS coluna FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pii_probe_tmp'`);
      const emClaro = rows.map((r) => r.coluna).filter((c) => PARECE_PII.test(c) && !PROTEGIDO_OU_NAO_VALOR.test(c));
      expect(emClaro).toEqual(['phone']);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS pii_probe_tmp`);
    }
  });
});
