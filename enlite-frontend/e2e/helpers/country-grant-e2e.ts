/**
 * country-grant-e2e.ts — pais (AR+BR) por GRUPO para o ator staff dos e2e de integracao, de forma CENTRAL.
 *
 * Por que existe: desde o #893 (`respondCountryScope`/`resolveCountryScope`) as rotas de paciente, vaga, worker e enquadre
 * respondem 403 COUNTRY_SCOPE_REQUIRED quando `iam.effective_countries(uid)` e vazio. Essa funcao so enxerga GRUPO com
 * `group_country_scopes` vivo E uma linha ACTIVE em `users` — o claim `country` do token mock e ignorado. O #893 consertou so
 * os e2e de backend (`worker-functions/tests/e2e/helpers/countryGrant.ts`); este arquivo e o lado do frontend.
 *
 * Mecanica = a do backend (mesma ideia, mesmos triggers), chamada por `tokenFor` (abac-stack-helper.ts):
 *  - `e2e_country_grants` registra o uid; um usuario PLACEHOLDER ACTIVE (ON CONFLICT DO NOTHING) faz o grant valer mesmo
 *    em spec que so usa token e nunca grava `users`;
 *  - trigger BEFORE INSERT em `users`: se o spec gravar o PROPRIO usuario depois (seedMockStaff etc.), o placeholder sai
 *    antes do INSERT — nao colide, e o spec fica com a linha que ele quis; trigger AFTER INSERT recoloca o membro no grupo;
 *  - AR+BR (como o backend): o comportamento anterior ao #893 nao filtrava pais, entao a uniao e o que preserva o resultado
 *    dos specs; `granted_by` preenchido satisfaz o consolidado multi-pais (resolveCountryScope.ts, D113).
 *
 * Quem DECLARA o proprio escopo (`seedStaffInGroup`, `group_country_scopes`, `grant_country`...) NAO recebe o default:
 * a deteccao le o fonte de quem chamou `tokenFor` (e dos helpers que ele importa), por ATOR. Ver `declaraProprioEscopo`.
 *
 * Sem limpeza (diferente do backend): o banco do job de integracao e efemero (compose do CI) e tudo aqui e idempotente
 * (`ON CONFLICT DO NOTHING`); o backend limpa porque os testes dele contam usuarios/grupos no MESMO banco entre arquivos.
 * Local contra um banco persistente o placeholder fica (display_name `e2e-country-grant-placeholder`, e-mail
 * `@e2e-placeholder.local`): `DELETE FROM users WHERE display_name = 'e2e-country-grant-placeholder'` limpa.
 *
 * So age em worker do Playwright (`TEST_WORKER_INDEX`): o processo que apenas lista os specs importa todos eles e nao deve
 * abrir centenas de `docker exec`. So age no banco do job comum (`docker exec`, como `runSQL`/`db-test-helper`): quando
 * `ABAC_TEST_DB_URL` esta setado o stack e o do engine ABAC ligado, onde cada spec monta o proprio grupo. Nunca lanca no
 * import: falha vira aviso e o spec reprova com o 403 visivel.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';

const TENANT = '00000000-0000-0000-0000-000000000001';
const GROUP = 'ee270000-0f00-0010-0001-000000000001';
const SCOPE_AR = 'ee270000-0f00-0010-0002-000000000001';
const SCOPE_BR = 'ee270000-0f00-0010-0002-000000000002';
const PLACEHOLDER = 'e2e-country-grant-placeholder';
const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';

/** O spec/helper monta o proprio escopo de pais: o default (AR+BR) colidiria com `uq_group_country_scopes_live`. */
const DECLARA_ESCOPO = /seedStaffInGroup|group_country_scopes|grant_country|grantCountry|COUNTRY_RLS_ENABLED/;

let instalado = false;

function lerFonte(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** Arquivos que chamaram a funcao (stack), exceto este e o `abac-stack-helper`. */
function chamadores(): string[] {
  const files = new Set<string>();
  for (const line of (new Error().stack ?? '').split('\n')) {
    const m = line.match(/\(?((?:file:\/\/)?\/[^():]+\.ts):\d+:\d+\)?\s*$/);
    const f = m?.[1]?.replace('file://', '');
    if (f && !/country-grant-e2e\.ts$|abac-stack-helper\.ts$/.test(f) && !f.includes('node_modules')) files.add(f);
  }
  return [...files];
}

/** Ator semeado como staff mock (linha em `users` por `seedMockStaff`/`loginComoStaffMock`): precisa do default mesmo que o arquivo declare escopo para OUTRO ator. */
const STAFF_MOCK = /seedMockStaff|loginComoStaffMock|seedAdminUser/;

const semComentarios = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const semImports = (src: string): string => src.replace(/^\s*(?:import|export)\s[^;]*?from\s+'[^']+';?/gm, '');

/**
 * Funcoes de um HELPER que declaram escopo de pais (corpo com `DECLARA_ESCOPO`, ou que chamam outra que declara).
 * O helper so DEFINE a possibilidade: quem declara e o spec que CHAMA a funcao. `export { seedStaffInGroup } from` (re-export) nao conta.
 */
function funcoesQueDeclaram(helperSrc: string): Set<string> {
  const src = semImports(semComentarios(helperSrc));
  const cabecas = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/gm)];
  const trechos = cabecas.map((m, i) => ({ nome: (m[1] ?? m[2])!, corpo: src.slice(m.index, cabecas[i + 1]?.index ?? src.length) }));
  const declaram = new Set(trechos.filter((t) => DECLARA_ESCOPO.test(t.corpo)).map((t) => t.nome));
  for (let mudou = true; mudou; ) {
    mudou = false;
    for (const t of trechos) {
      if (declaram.has(t.nome)) continue;
      if ([...declaram].some((n) => new RegExp(`\\b${n}\\b`).test(t.corpo))) {
        declaram.add(t.nome);
        mudou = true;
      }
    }
  }
  return declaram;
}

/** O uid literal (`'x'`) do ator aparece neste fonte? (uid de template nao conta: seria casar prefixo com ator dinamico de outro teste.) */
function mencionaUid(src: string, uid: string): boolean {
  return src.includes(`'${uid}'`);
}

/**
 * O chamador declara o proprio escopo PARA ESTE ATOR?
 *  - o fonte do proprio spec/helper chamador cita `DECLARA_ESCOPO` (ele monta o grupo do ator), OU
 *  - o spec CHAMA (fora de import/comentario) uma funcao de um helper importado (1 nivel) que declara escopo. Ver `funcoesQueDeclaram`:
 *    antes o fonte do helper importado contava inteiro, e `bloqueados-067-helper` (que tem `seedStaffComPais`, nunca chamada pelos
 *    specs 067 de ficha/lista) isentava o staff deles — 403 COUNTRY_SCOPE_REQUIRED em todas as rotas.
 * Excecao: arquivo que declara escopo so para um ator dinamico (089: `seedStaffInGroup` no teste 12) mas usa OUTRO ator como staff mock
 * (`seedMockStaff`/`loginComoStaffMock`, uid literal) NAO isenta esse staff.
 */
export function declaraProprioEscopo(uid: string, files: string[] = chamadores()): boolean {
  let declara = false;
  let staffMock = false;
  for (const f of files) {
    const src = lerFonte(f);
    if (mencionaUid(src, uid) && STAFF_MOCK.test(src)) staffMock = true;
    if (DECLARA_ESCOPO.test(src)) declara = true;
    const corpo = semImports(semComentarios(src));
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      const base = resolve(dirname(f), m[1]);
      // `abac-stack-helper` DEFINE `seedStaffInGroup`: so o uso (no fonte do chamador) conta, nunca a definicao.
      if (/\/abac-stack-helper$|\/country-grant-e2e$/.test(base)) continue;
      const usadas = [...funcoesQueDeclaram(lerFonte(`${base}.ts`))].filter((n) => new RegExp(`\\b${n}\\b`).test(corpo));
      if (usadas.length > 0) declara = true;
    }
  }
  return declara && !staffMock;
}

/** DDL (tabela, funcoes, triggers): so na 1a chamada do processo — nenhum cleanup de spec apaga isso e CREATE TRIGGER trava `users`. */
const INSTALL_DDL_SQL = `
SELECT pg_advisory_xact_lock(727002);
CREATE TABLE IF NOT EXISTS e2e_country_grants (uid VARCHAR PRIMARY KEY);
CREATE OR REPLACE FUNCTION e2e_country_grant_before_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, iam AS $f$
BEGIN
  DELETE FROM users WHERE firebase_uid = NEW.firebase_uid AND display_name = '${PLACEHOLDER}';
  RETURN NEW;
END $f$;
CREATE OR REPLACE FUNCTION e2e_country_grant_after_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, iam AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM e2e_country_grants g WHERE g.uid = NEW.firebase_uid) THEN
    INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES (NEW.firebase_uid, '${GROUP}', '${TENANT}')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $f$;
CREATE OR REPLACE TRIGGER e2e_country_grant_before BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION e2e_country_grant_before_user();
CREATE OR REPLACE TRIGGER e2e_country_grant_after AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION e2e_country_grant_after_user();
`;

/** Linhas (grupo + escopos): a CADA chamada, idempotente — um spec pode ter apagado o grupo. */
const INSTALL_ROWS_SQL = `
INSERT INTO iam.permission_groups (id, tenant_id, name) VALUES ('${GROUP}', '${TENANT}', 'e2e frontend default AR+BR') ON CONFLICT DO NOTHING;
INSERT INTO iam.group_country_scopes (id, group_id, country, granted_by, reason) VALUES
  ('${SCOPE_AR}', '${GROUP}', 'AR', 'e2e-default', 'padrao dos e2e'),
  ('${SCOPE_BR}', '${GROUP}', 'BR', 'e2e-default', 'padrao dos e2e') ON CONFLICT DO NOTHING;
`;

/** SQL de concessao ao `uid` (so inclui o que o uid exige; o uid vai como literal escapado). */
export function grantSql(uid: string): string {
  const u = uid.replace(/'/g, "''");
  return `
INSERT INTO e2e_country_grants (uid) VALUES ('${u}') ON CONFLICT DO NOTHING;
INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
  VALUES ('${u}', '${u}@e2e-placeholder.local', '${PLACEHOLDER}', 'recruiter', true, 'ACTIVE', '${TENANT}') ON CONFLICT (firebase_uid) DO NOTHING;
INSERT INTO iam.user_groups (user_id, group_id, tenant_id) SELECT firebase_uid, '${GROUP}', '${TENANT}' FROM users WHERE firebase_uid = '${u}' ON CONFLICT DO NOTHING;
`;
}

function psqlStdin(sql: string): void {
  execSync(`docker exec -i ${CONTAINER} psql -U enlite_admin -d enlite_e2e -v ON_ERROR_STOP=1 -q -f -`, {
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Concede AR+BR por grupo ao `uid` (staff). Idempotente; no-op fora do worker, no stack ABAC e para quem declara o proprio escopo. */
export function ensureDefaultCountries(uid: string, role: string | undefined, files?: string[]): void {
  if (process.env.TEST_WORKER_INDEX === undefined || process.env.ABAC_TEST_DB_URL) return;
  if (role === 'worker') return;
  if (declaraProprioEscopo(uid, files)) return;
  // SEM memo por uid: outro spec apaga a linha em `users` do ator (`cleanupMockStaff` no afterAll; cascade leva a filiacao) e um
  // ator so-token (ex.: ITINERARIO_STAFF) so recupera o grant se ele for refeito a CADA `tokenFor`. Custo: 1 `docker exec`.
  try {
    psqlStdin(`BEGIN;\n${instalado ? '' : INSTALL_DDL_SQL}${INSTALL_ROWS_SQL}${grantSql(uid)}COMMIT;`);
    instalado = true;
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    console.warn(`[country-grant-e2e] grant de pais falhou para ${uid} (o spec vai ver 403): ${e.stderr?.toString() ?? e.message}`);
  }
}
