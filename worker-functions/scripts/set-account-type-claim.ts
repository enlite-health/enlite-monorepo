/**
 * scripts/set-account-type-claim.ts — grava o custom claim `account_type` nas contas
 * que já existem (D294, 07/09/2026).
 *
 * A fronteira staff × prestador deixou de ser o papel (`role`) e passou a ser o
 * tipo da conta: coluna `users.account_type` (migration 414) espelhada no claim
 * `account_type` do Identity Platform. Conta criada depois da 414 já nasce com o
 * claim (`CreateAdminUserUseCase`, auto-provisão, `onUserCreate`); as anteriores
 * dependem deste script. Enquanto o claim não chega, o servidor deriva do claim
 * `role` (ponte) — o script existe para a ponte poder morrer (D293, passos 2-3).
 *
 * A FONTE é a coluna: o claim gravado é `users.account_type` da linha, nunca um
 * default. Linha sem conta no IdP é listada e pulada (não se inventa conta).
 *
 * Uso:
 *   npm run claims:account-type:dry                 # lista quem está sem claim
 *   npm run claims:account-type                     # grava (--execute)
 *   npm run claims:account-type -- --uid <uid>
 *   npm run claims:account-type:dry -- --show-all   # inclui quem já tem
 *
 * Efeito no usuário: o claim entra no PRÓXIMO ID token (refresh em até 1h).
 */
import { Pool } from 'pg';
import { mergeCustomClaims } from '@modules/identity/infrastructure/mergeCustomClaims';
import { isAccountType } from '@modules/identity/domain/AccountType';
import { argValue } from './lib/cliArgs';

const isDryRun = !process.argv.includes('--execute');
const showAll = process.argv.includes('--show-all');
const targetUid = argValue('--uid');

function resolveIdpProject(): string {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error('Defina FIREBASE_PROJECT_ID (ou GOOGLE_CLOUD_PROJECT) — o IdP é por ambiente');
  }
  return projectId;
}

interface AccountRow {
  firebase_uid: string;
  email: string | null;
  account_type: string;
}

async function listAccounts(pool: Pool): Promise<AccountRow[]> {
  const params: unknown[] = [];
  let where = 'is_active = true AND firebase_uid IS NOT NULL';
  if (targetUid) {
    params.push(targetUid);
    where += ` AND firebase_uid = $${params.length}`;
  }
  const res = await pool.query<AccountRow>(
    `SELECT firebase_uid, email, account_type FROM users WHERE ${where} ORDER BY account_type, email`,
    params,
  );
  return res.rows;
}

async function main(): Promise<void> {
  const projectId = resolveIdpProject();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const admin = require('firebase-admin');
  if (admin.apps.length === 0) admin.initializeApp({ projectId });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL não definida');
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const contas = await listAccounts(pool);
    console.log(`[claims] contas ativas em users: ${contas.length} (projeto ${projectId})`);

    let gravados = 0;
    let jaTinham = 0;
    let semConta = 0;
    let invalidos = 0;

    for (const row of contas) {
      if (!isAccountType(row.account_type)) {
        // A coluna tem CHECK; se isto acontecer, o vocabulário do código ficou atrás do banco.
        invalidos += 1;
        console.log(`  [tipo desconhecido no código: ${row.account_type}] ${row.email ?? row.firebase_uid}`);
        continue;
      }
      let user;
      try {
        user = await admin.auth().getUser(row.firebase_uid);
      } catch {
        semConta += 1;
        console.log(`  [sem conta no IdP] ${row.email ?? row.firebase_uid}`);
        continue;
      }

      const atual = (user.customClaims ?? {}).account_type as string | undefined;
      if (atual === row.account_type) {
        jaTinham += 1;
        if (showAll) console.log(`  [já tem ${atual}] ${row.email ?? row.firebase_uid}`);
        continue;
      }

      console.log(`  [${isDryRun ? 'DRY' : 'SET'}] ${row.email ?? row.firebase_uid}: ${atual ?? '—'} → ${row.account_type}`);
      if (!isDryRun) {
        // Mesmo helper do backend — preserva `role` e `country` (setCustomUserClaims substitui o objeto).
        await mergeCustomClaims(row.firebase_uid, { account_type: row.account_type });
        gravados += 1;
      }
    }

    console.log(
      `[claims] ${isDryRun ? 'DRY-RUN — nada gravado' : 'aplicado'}: ` +
        `gravados=${gravados} já_tinham=${jaTinham} sem_conta_idp=${semConta} tipo_invalido=${invalidos}`,
    );
    if (!isDryRun && gravados > 0) {
      console.log('[claims] o claim entra no PRÓXIMO token — quem está logado só vê após refresh (≤1h).');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('[claims] falhou:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
