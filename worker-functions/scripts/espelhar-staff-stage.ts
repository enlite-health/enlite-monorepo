/**
 * scripts/espelhar-staff-stage.ts — a STAGE simula a produção (D208, 28/08/2026).
 *
 * POR QUÊ: o time vai configurar grupos, células, países e features EM STAGE, e a
 * configuração migra pronta para prod. Para isso a stage precisa das MESMAS
 * pessoas de prod (e-mail, papel, departamento) — hoje ela tem 4 staff, prod 22.
 *
 * O QUE FAZ, por pessoa de prod (staff ativo):
 *   1. garante a conta no Identity Platform de `enlite-stg` (por e-mail; cria SEM
 *      senha — o login é Google, e o Firebase liga ao existente pelo e-mail);
 *   2. upsert da linha em `users` de stage (uid do IdP de stage, e-mail, nome,
 *      papel, departamento, ACTIVE, tenant Enlite);
 *   3. claim `country` no IdP de stage (D207: AR para todos; admins ganham BR por
 *      escopo de grupo, não por claim — ninguém perde visibilidade sob a RLS).
 * E, com `--contas-teste`, cria 3 contas e-mail/senha para as provas V2/V3:
 *   gestor (Acesso Master) · recrutador (Recrutador) · sem grupo. Senhas geradas e
 *   guardadas no Secret Manager de `enlite-stg` (`abac-qa-accounts`), NUNCA no log.
 *
 * NUNCA escreve em prod: `DATABASE_URL_PROD` só é lida. Idempotente: rodar 2× dá o
 * mesmo estado. `--dry-run` é o default; `--execute` grava. Log só com contagens e
 * e-mail MASCARADO.
 *
 * Uso (proxies: prod em 5436, stage em 5434):
 *   npm run espelho:stage:dry -- [--contas-teste]     # só mostra
 *   npm run espelho:stage -- [--contas-teste]         # grava (== --execute)
 *
 * GRUPO DAS CONTAS DE TESTE — por que INSERT direto e não `iam.add_member` (279):
 * a 279 exige um ATOR com `permission_management:write` em sessão (`_require_manager`),
 * e este script roda justamente quando a stage ainda NÃO tem gestor nenhum — ele é o
 * bootstrap do primeiro, como o seed da 206 foi. A autoria não fica vazia: `assigned_by`
 * recebe o uid do gestor QA (a primeira conta criada), e o comentário na linha diz isso.
 */
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { mergeCustomClaims } from '@modules/identity/infrastructure/mergeCustomClaims';

const STAFF_ROLES = ['admin', 'recruiter', 'community_manager'];
const TENANT = '00000000-0000-0000-0000-000000000001';
const EXECUTE = process.argv.includes('--execute');
const CONTAS_TESTE = process.argv.includes('--contas-teste');
const mask = (e: string) => e.replace(/^(..).*@/, '$1…@');

interface Staff { email: string; display_name: string | null; role: string; department: string | null }

const TESTE = [
  { email: 'abac.qa.gestor@enlite.health', role: 'admin', nome: 'QA Gestor (ABAC)', grupo: 'Acesso Master' },
  { email: 'abac.qa.recrutador@enlite.health', role: 'recruiter', nome: 'QA Recrutador (ABAC)', grupo: 'Recrutador' },
  { email: 'abac.qa.semgrupo@enlite.health', role: 'recruiter', nome: 'QA Sem Grupo (ABAC)', grupo: null },
];

async function main(): Promise<void> {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (projectId !== 'enlite-stg') throw new Error('FIREBASE_PROJECT_ID tem de ser enlite-stg — este script só escreve em STAGE');
  const prodUrl = process.env.DATABASE_URL_PROD;
  const stgUrl = process.env.DATABASE_URL;
  if (!prodUrl || !stgUrl) throw new Error('DATABASE_URL_PROD (leitura) e DATABASE_URL (stage) são obrigatórias');
  if (/enlite_e2e/.test(stgUrl)) throw new Error('DATABASE_URL aponta para o banco de e2e local — abortando');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const admin = require('firebase-admin');
  if (admin.apps.length === 0) admin.initializeApp({ projectId });
  const auth = admin.auth();

  const prod = new Pool({ connectionString: prodUrl });
  const stg = new Pool({ connectionString: stgUrl });
  const c = { idpCriada: 0, idpJaTinha: 0, linhaNova: 0, linhaAtualizada: 0, claim: 0, claimJaTinha: 0 };
  /** O mesmo predicado nas duas pontas — senão "4 → 28" compara réguas diferentes. */
  const STAFF_ATIVO = `role = ANY($1) AND is_active = true AND status = 'ACTIVE'`;
  let gestorQaUid: string | null = null;
  try {
    const { rows: staff } = await prod.query<Staff>(
      `SELECT email, display_name, role, department FROM users
        WHERE ${STAFF_ATIVO} AND email IS NOT NULL ORDER BY email`,
      [STAFF_ROLES],
    );
    console.log(`[espelho] staff ativo em PROD: ${staff.length} (${EXECUTE ? 'EXECUTE' : 'DRY-RUN'})`);

    const alvo: Array<Staff & { senha?: string; grupo?: string | null }> = [...staff];
    if (CONTAS_TESTE) for (const t of TESTE) alvo.push({ email: t.email, display_name: t.nome, role: t.role, department: 'qa', senha: randomBytes(18).toString('base64url'), grupo: t.grupo });

    const senhas: Record<string, string> = {};
    for (const p of alvo) {
      // 1. IdP
      let uid: string;
      try {
        uid = (await auth.getUserByEmail(p.email)).uid; c.idpJaTinha += 1;
      } catch {
        c.idpCriada += 1;
        if (!EXECUTE) { console.log(`  [criaria conta IdP] ${mask(p.email)}`); uid = `dry-${c.idpCriada}`; }
        else {
          const u = await auth.createUser({ email: p.email, displayName: p.display_name ?? undefined, emailVerified: true, ...(p.senha ? { password: p.senha } : {}) });
          uid = u.uid;
        }
      }
      if (p.senha) senhas[p.email] = p.senha;

      if (p.email === TESTE[0].email) gestorQaUid = uid;

      // 2-4. Tudo do BANCO desta pessoa numa transação: falha no meio não deixa
      //      linha sem grupo nem grupo sem linha (o IdP fica fora — não é transacional).
      const existente = await stg.query<{ firebase_uid: string; role: string }>(`SELECT firebase_uid, role FROM users WHERE email = $1`, [p.email]);
      if (existente.rowCount === 0) c.linhaNova += 1; else c.linhaAtualizada += 1;
      if (!EXECUTE) continue;

      const client = await stg.connect();
      try {
        await client.query('BEGIN');
        if (existente.rowCount === 0) {
          await client.query(
            `INSERT INTO users (firebase_uid, email, display_name, role, department, is_active, status, tenant_id)
             VALUES ($1, $2, $3, $4, $5, true, 'ACTIVE', $6)`,
            [uid, p.email, p.display_name, p.role, p.department, TENANT]);
        } else {
          // Vínculo vivo com OUTRO uid impediria o UPDATE (FK sem ON UPDATE CASCADE):
          // remove o vínculo antigo com autoria de sistema antes de trocar o uid.
          const antigo = existente.rows[0].firebase_uid;
          if (antigo !== uid) {
            await client.query(`UPDATE iam.user_groups SET removed_at = now() WHERE user_id = $1 AND removed_at IS NULL`, [antigo]);
          }
          await client.query(
            `UPDATE users SET firebase_uid = $1, display_name = COALESCE($2, display_name), role = $3, department = COALESCE($4, department),
                    is_active = true, status = 'ACTIVE', tenant_id = COALESCE(tenant_id, $5), updated_at = now() WHERE email = $6`,
            [uid, p.display_name, p.role, p.department, TENANT, p.email]);
        }

        // grupo das contas de teste — INSERT direto com AUTORIA (ver cabeçalho: é o
        // bootstrap do primeiro gestor; a 279 exigiria um gestor que ainda não existe).
        if (p.grupo) {
          const g = await client.query<{ id: string }>(`SELECT id FROM iam.permission_groups WHERE name = $1 AND tenant_id = $2 AND archived_at IS NULL`, [p.grupo, TENANT]);
          if (g.rowCount !== 1) throw new Error(`grupo '${p.grupo}' não existe em stage`);
          const ja = await client.query(`SELECT 1 FROM iam.user_groups WHERE user_id = $1 AND group_id = $2 AND removed_at IS NULL`, [uid, g.rows[0].id]);
          if (ja.rowCount === 0) {
            await client.query(
              `INSERT INTO iam.user_groups (user_id, group_id, tenant_id, assigned_by) VALUES ($1, $2, $3, $4)`,
              [uid, g.rows[0].id, TENANT, gestorQaUid ?? uid],
            );
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      // claim country = AR (D207) — depois do banco, fora da transação
      const cur = ((await auth.getUser(uid)).customClaims ?? {}).country;
      if (cur === 'AR') c.claimJaTinha += 1; else { await mergeCustomClaims(uid, { country: 'AR' }); c.claim += 1; }
    }
    console.log(`[espelho] IdP: criadas=${c.idpCriada} existentes=${c.idpJaTinha} · users(stage): novas=${c.linhaNova} atualizadas=${c.linhaAtualizada} · claim AR: atribuídos=${c.claim} já_tinham=${c.claimJaTinha}`);

    if (EXECUTE && CONTAS_TESTE && Object.keys(senhas).length > 0) {
      const payload = JSON.stringify(senhas);
      try {
        execFileSync('gcloud', ['secrets', 'create', 'abac-qa-accounts', '--project=enlite-stg', '--replication-policy=automatic', '--data-file=-'], { input: payload, stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (e) {
        // Só "já existe" cai para `versions add`; qualquer outra causa (gcloud sem auth,
        // sem permissão) sobe com o stderr original, não some num segundo erro.
        const stderr = String((e as { stderr?: Buffer }).stderr ?? '');
        if (!/already exists|ALREADY_EXISTS/i.test(stderr)) throw new Error(`gcloud secrets create falhou: ${stderr.trim()}`);
        execFileSync('gcloud', ['secrets', 'versions', 'add', 'abac-qa-accounts', '--project=enlite-stg', '--data-file=-'], { input: payload, stdio: ['pipe', 'ignore', 'pipe'] });
      }
      console.log(`[espelho] senhas das ${Object.keys(senhas).length} contas de teste gravadas no secret enlite-stg/abac-qa-accounts (não impressas)`);
    }
    const stgCount = await stg.query(`SELECT count(*) FROM users WHERE ${STAFF_ATIVO}`, [STAFF_ROLES]);
    console.log(`[espelho] staff ativo em STAGE agora: ${stgCount.rows[0].count}`);
  } finally { await prod.end(); await stg.end(); }
}
main().catch((e) => { console.error('[espelho] falhou:', e.message); process.exit(1); });
