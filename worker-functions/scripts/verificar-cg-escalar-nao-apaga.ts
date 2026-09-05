/**
 * verificar-cg-escalar-nao-apaga.ts — a C-G do parecer do `lex` da Fase 3.
 *
 * O defeito que ele achou: `insuranceVerifiedReadable` era emitido pelo mapper, declarado no
 * tipo do `PatientService`, descrito num comentário como "a mesma distinção da D167" — e
 * NUNCA consumido. `insurance_verified = EXCLUDED.insurance_verified` gravava `?? null` de
 * qualquer jeito. Uma leitura `options_partially_resolved` (pediu 2 rótulos, o catálogo
 * traduziu 1) zerava a coluna que o PAINEL lê, enquanto a tabela múltipla — corretamente —
 * não era tocada. Banco cheio, tela vazia.
 *
 * ⚠️ Sinal de proteção que existe no TIPO e não existe no CAMINHO é pior que não existir:
 * ele faz quem lê o código acreditar que está protegido.
 *
 * Quatro medições, com controle negativo do UPDATE anterior à C-G.
 * Só Postgres local em docker; paciente sintético; ROLLBACK no fim.
 */
import { Pool } from 'pg';
import { assertLocalDatabaseTarget } from '../src/shared/database/assertLocalDatabaseTarget';
const U = `UPDATE patients SET insurance_verified = CASE WHEN $3::boolean THEN $2 ELSE patients.insurance_verified END WHERE id=$1`;
const ANTIGO = `UPDATE patients SET insurance_verified = $2 WHERE id=$1`;
/**
 * A MESMA trava dos outros 9 `verificar-*` desta frente — reusada de `src/shared/database`,
 * nunca reimplementada. Este script INSERT em `patients` e faz 4 `UPDATE patients`, e o cabeçalho acima
 * dizia "só Postgres local em docker" sem que nada impedisse o contrário: com o
 * `cloud-sql-proxy` vivo, `localhost:5436` é PRODUÇÃO. Cabeçalho não é trava (gate F5, D4).
 */
export function criarPool(env: NodeJS.ProcessEnv = process.env): Pool {
  assertLocalDatabaseTarget(env.DATABASE_URL);
  return new Pool({ connectionString: env.DATABASE_URL });
}

async function main(): Promise<void> {
  const p = criarPool(); const c = await p.connect();
  await c.query('BEGIN');
  const novo = async () => (await c.query<{id:string}>(
    `INSERT INTO patients (first_name,last_name,country,is_test,insurance_verified) VALUES ('S','FIXTURE-CG','AR',true,'OSDE') RETURNING id`)).rows[0].id;
  const le = async (id:string) => (await c.query<{v:string|null}>('SELECT insurance_verified v FROM patients WHERE id=$1',[id])).rows[0].v;
  const a = await novo(); await c.query(U,[a,'Swiss Medical',true]);
  const b = await novo(); await c.query(U,[b,null,true]);
  const d = await novo(); await c.query(U,[d,null,false]);
  const e = await novo(); await c.query(ANTIGO,[e,null]);
  console.log(`[1] legível com valor  → ${JSON.stringify(await le(a))}  (esperado "Swiss Medical")`);
  console.log(`[2] legível e VAZIO    → ${JSON.stringify(await le(b))}  (esperado null — D-E: vazio se escreve)`);
  console.log(`[3] ILEGÍVEL           → ${JSON.stringify(await le(d))}  (esperado "OSDE" — não toca)`);
  console.log(`[4] CONTROLE NEGATIVO, o UPDATE de antes da C-G → ${JSON.stringify(await le(e))}  (apaga)`);
  const ok = (await le(a))==='Swiss Medical' && (await le(b))===null && (await le(d))==='OSDE' && (await le(e))===null;
  await c.query('ROLLBACK'); c.release(); await p.end();
  console.log(ok ? '\n=== VERIFICAÇÕES: TODAS OK ===' : '\n=== FALHOU ===');
  process.exit(ok?0:1);
}

/* istanbul ignore next -- entrypoint do CLI: só roda fora de teste (require.main === module) */
if (require.main === module) {
  main().catch(e=>{console.error('ERRO:',e.message);process.exit(1)});
}
