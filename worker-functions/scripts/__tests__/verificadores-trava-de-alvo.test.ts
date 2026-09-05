/**
 * verificadores-trava-de-alvo.test.ts — gate F5, D4.
 *
 * 🔴 O DEFEITO: dos 12 `verificar-*` desta frente, 11 abrem pool no banco (o 12º,
 * `verificar-twilio-content-write`, não toca em `DATABASE_URL`). Desses 11, NOVE chamavam
 * `assertLocalDatabaseTarget` antes de abrir o pool e DOIS não — e um dos dois, `verificar-cg-escalar-nao-apaga`, abre transação
 * de ESCRITA e faz `INSERT INTO patients` + 4 `UPDATE patients` contra o que estiver em
 * `DATABASE_URL`, apesar do cabeçalho declarar "Só Postgres local em docker". Cabeçalho não é
 * trava. Com o `cloud-sql-proxy` vivo na máquina, `localhost:5436` É produção.
 *
 * 🔒 Régua POSITIVA e MESMA para os dois (uma tabela, não dois blocos): a trava que vale é a
 * dos 9 irmãos, não uma parecida. Cada recusa afirma a MENSAGEM — `toThrow()` sozinho ficaria
 * verde com a trava morta por import errado (ReferenceError), o modo de falha já medido em
 * `ingest-icd11-catalog.trava.test.ts`.
 */
import { Pool } from 'pg';
import { criarPool as poolCg } from '../verificar-cg-escalar-nao-apaga';
import { criarPool as pool42 } from '../verificar-4.2-divergencia';

const VERIFICADORES: ReadonlyArray<[string, (env?: NodeJS.ProcessEnv) => Pool]> = [
  ['verificar-cg-escalar-nao-apaga (INSERT/UPDATE em patients)', poolCg],
  ['verificar-4.2-divergencia --autoteste (INSERT em patients)', pool42],
];

const env = (u?: string) => ({ DATABASE_URL: u }) as NodeJS.ProcessEnv;

function recusa(criar: (e?: NodeJS.ProcessEnv) => Pool, url?: string): Error {
  let pool: Pool | undefined;
  try {
    pool = criar(env(url));
  } catch (e) {
    return e as Error;
  }
  void pool.end();
  throw new Error(`ABRIU POOL para ${JSON.stringify(url)} — deveria ter recusado antes de conectar`);
}

describe.each(VERIFICADORES)('trava de alvo de %s', (_nome, criar) => {
  it('CONTROLE NEGATIVO: ACEITA o docker local — o alvo para o qual o verificador existe', async () => {
    const pool = criar(env('postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e'));
    expect(pool).toBeDefined();
    await pool.end();
  });

  it('CONTROLE NEGATIVO: ACEITA 127.0.0.1 na porta 5433', async () => {
    const pool = criar(env('postgresql://u:p@127.0.0.1:5433/enlite_e2e'));
    expect(pool).toBeDefined();
    await pool.end();
  });

  it('RECUSA a porta de PRD (5436) — o cloud-sql-proxy faz "localhost" significar produção', () => {
    const e = recusa(criar, 'postgresql://u:p@localhost:5436/enlite_ar');
    expect(e).not.toBeInstanceOf(ReferenceError);
    expect(e.message).toMatch(/^TRAVA: porta 5436 /);
  });

  it('RECUSA a porta de stage (5434)', () => {
    expect(recusa(criar, 'postgresql://u:p@localhost:5434/enlite_ar').message).toMatch(/^TRAVA: porta 5434 /);
  });

  it('RECUSA a porta da réplica local de PRD (5437)', () => {
    expect(recusa(criar, 'postgresql://u:p@localhost:5437/enlite_e2e').message).toMatch(/^TRAVA: porta 5437 /);
  });

  it('RECUSA "?port=5436" — o parâmetro vence a URL para o pg', () => {
    expect(recusa(criar, 'postgresql://u:p@localhost:5432/enlite_e2e?port=5436').message)
      .toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  it('RECUSA socket do Cloud SQL na URL', () => {
    expect(recusa(criar, 'postgresql://u:p@localhost:5432/enlite_e2e?host=/cloudsql/enlite-prd:x:y').message)
      .toMatch(/^TRAVA: DATABASE_URL com query string/);
  });

  it('RECUSA host remoto', () => {
    expect(recusa(criar, 'postgresql://u:p@10.0.0.5:5432/enlite_e2e').message).toMatch(/^TRAVA: host "10\.0\.0\.5"/);
  });

  it('RECUSA base fora da lista', () => {
    expect(recusa(criar, 'postgresql://u:p@localhost:5432/enlite_ar').message).toMatch(/^TRAVA: base "enlite_ar"/);
  });

  it('RECUSA DATABASE_URL ausente — ausência não é local', () => {
    expect(recusa(criar, undefined).message).toMatch(/^TRAVA: DATABASE_URL não definido/);
  });
});
