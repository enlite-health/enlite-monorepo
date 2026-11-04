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
 * Conta `agent` (spec 078, M2) é pulada: não existe usuário Firebase para ela.
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

/** Sem e-mail de propósito: a saída vai para terminal e log de operação — uid basta para agir, e-mail é PII. */
export interface AccountRow {
  firebase_uid: string;
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
    `SELECT firebase_uid, account_type FROM users WHERE ${where} ORDER BY account_type, firebase_uid`,
    params,
  );
  return res.rows;
}

/** `agent` (spec 078, M2) é conta de serviço do MCP: NÃO existe usuário no Identity Platform, então não há claim a gravar. */
export function semUsuarioFirebase(accountType: string): boolean {
  return accountType === 'agent';
}

export interface ClaimDeps {
  /** Lança se a conta não existe no IdP. */
  getUser(uid: string): Promise<{ customClaims?: Record<string, unknown> | null }>;
  setClaim(uid: string, accountType: string): Promise<void>;
  log(linha: string): void;
}

export interface ClaimTotais {
  gravados: number;
  jaTinham: number;
  semConta: number;
  invalidos: number;
  pulados: number;
}

/** O laço do script, sem E/S própria (testável): decide por linha se grava, pula ou conta. */
export async function processarContas(
  contas: readonly AccountRow[],
  deps: ClaimDeps,
  opts: { dryRun: boolean; showAll: boolean },
): Promise<ClaimTotais> {
  const t: ClaimTotais = { gravados: 0, jaTinham: 0, semConta: 0, invalidos: 0, pulados: 0 };
  for (const row of contas) {
    if (semUsuarioFirebase(row.account_type)) {
      t.pulados += 1;
      deps.log(`  [pulado (agent: sem usuário Firebase)] ${row.firebase_uid}`);
      continue;
    }
    if (!isAccountType(row.account_type)) {
      // A coluna tem CHECK; se isto acontecer, o vocabulário do código ficou atrás do banco.
      t.invalidos += 1;
      deps.log(`  [tipo desconhecido no código: ${row.account_type}] ${row.firebase_uid}`);
      continue;
    }
    let user;
    try {
      user = await deps.getUser(row.firebase_uid);
    } catch {
      t.semConta += 1;
      deps.log(`  [sem conta no IdP] ${row.firebase_uid}`);
      continue;
    }

    const atual = (user.customClaims ?? {}).account_type as string | undefined;
    if (atual === row.account_type) {
      t.jaTinham += 1;
      if (opts.showAll) deps.log(`  [já tem ${atual}] ${row.firebase_uid}`);
      continue;
    }

    deps.log(`  [${opts.dryRun ? 'DRY' : 'SET'}] ${row.firebase_uid}: ${atual ?? '—'} → ${row.account_type}`);
    if (!opts.dryRun) {
      await deps.setClaim(row.firebase_uid, row.account_type);
      t.gravados += 1;
    }
  }
  return t;
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

    const { gravados, jaTinham, semConta, invalidos, pulados } = await processarContas(
      contas,
      {
        getUser: (uid) => admin.auth().getUser(uid),
        // Mesmo helper do backend — preserva `role` e `country` (setCustomUserClaims substitui o objeto).
        setClaim: (uid, accountType) => mergeCustomClaims(uid, { account_type: accountType }),
        log: (l) => console.log(l),
      },
      { dryRun: isDryRun, showAll },
    );

    console.log(
      `[claims] ${isDryRun ? 'DRY-RUN — nada gravado' : 'aplicado'}: ` +
        `gravados=${gravados} já_tinham=${jaTinham} sem_conta_idp=${semConta} tipo_invalido=${invalidos} pulados_agent=${pulados}`,
    );
    if (!isDryRun && gravados > 0) {
      console.log('[claims] o claim entra no PRÓXIMO token — quem está logado só vê após refresh (≤1h).');
    }
  } finally {
    await pool.end();
  }
}

// Só roda como CLI; `import` (teste) não dispara o script.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[claims] falhou:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
