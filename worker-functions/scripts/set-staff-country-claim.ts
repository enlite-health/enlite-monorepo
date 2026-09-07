/**
 * scripts/set-staff-country-claim.ts — atribui o custom claim `country` ao staff
 * (ABAC país Fase 1, task 3.2).
 *
 * O claim é a FONTE do `app.user_country` que a RLS lê (design, decisão 4):
 * muda raro, tolera a propagação de até 1h do token, e por isso não precisa de
 * ida ao banco por request. Grant de exceção (ver outro país) é outra coisa —
 * esse vive em `group_country_scopes` e é resolvido a cada query, para revogação
 * ter efeito imediato.
 *
 * ⚠️ O DEFAULT 'AR' SÓ EXISTE AQUI, no ATO da atribuição, porque hoje 100% do
 * staff opera na Argentina. Em runtime não há default nenhum: staff sem claim
 * enxerga ZERO linha (lex C3). Se algum dia alguém for do Brasil, este script é
 * rodado com `--country BR --uid <uid>` ANTES de a pessoa logar.
 *
 * Uso:
 *   npm run claims:country:dry                     # lista quem está sem claim
 *   npm run claims:country -- --country AR         # atribui a todo staff sem claim
 *   npm run claims:country -- --uid <uid> --country BR
 *   npm run claims:country:dry -- --show-all       # inclui quem já tem claim
 *
 * Efeito no usuário: o claim entra no PRÓXIMO ID token. Quem já está logado só
 * passa a enxergar depois do refresh (até 1h) — ou de um logout/login.
 */

import { Pool } from 'pg';
import { mergeCustomClaims } from '@modules/identity/infrastructure/mergeCustomClaims';
import { argValue } from './lib/cliArgs';

const COUNTRIES = ['AR', 'BR'] as const;
type Country = (typeof COUNTRIES)[number];

const isDryRun = !process.argv.includes('--execute');
const showAll = process.argv.includes('--show-all');

const targetUid = argValue('--uid');
const rawCountry = argValue('--country') ?? 'AR';
if (!(COUNTRIES as readonly string[]).includes(rawCountry)) {
  throw new Error(`--country inválido: ${rawCountry} (use ${COUNTRIES.join('|')})`);
}
const country = rawCountry as Country;

function resolveIdpProject(): string {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error('Defina FIREBASE_PROJECT_ID (ou GOOGLE_CLOUD_PROJECT) — o IdP é por ambiente');
  }
  return projectId;
}

interface StaffRow {
  firebase_uid: string;
  email: string | null;
  role: string;
}

async function listStaff(pool: Pool): Promise<StaffRow[]> {
  // D294: staff é `account_type = 'staff'`, não a lista de papéis.
  const params: unknown[] = ['staff'];
  let where = 'account_type = $1 AND is_active = true AND firebase_uid IS NOT NULL';
  if (targetUid) {
    params.push(targetUid);
    where += ` AND firebase_uid = $${params.length}`;
  }
  const res = await pool.query<StaffRow>(
    `SELECT firebase_uid, email, role FROM users WHERE ${where} ORDER BY email`,
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
    const staff = await listStaff(pool);
    console.log(`[claims] staff ativo encontrado: ${staff.length} (projeto ${projectId})`);

    let assigned = 0;
    let already = 0;
    let missingAccount = 0;

    for (const row of staff) {
      let user;
      try {
        user = await admin.auth().getUser(row.firebase_uid);
      } catch {
        // uid de banco sem conta no IdP (import antigo) — não inventar conta.
        missingAccount += 1;
        console.log(`  [sem conta no IdP] ${row.email ?? row.firebase_uid}`);
        continue;
      }

      const current = (user.customClaims ?? {}).country as string | undefined;
      if (current === country) {
        already += 1;
        if (showAll) console.log(`  [já tem ${current}] ${row.email ?? row.firebase_uid}`);
        continue;
      }

      const action = current ? `${current} → ${country}` : `— → ${country}`;
      console.log(`  [${isDryRun ? 'DRY' : 'SET'}] ${row.email ?? row.firebase_uid} (${row.role}): ${action}`);

      if (!isDryRun) {
        // Mesmo helper que o backend usa para escrever `role` — preserva os
        // demais claims (setCustomUserClaims SUBSTITUI o objeto inteiro).
        await mergeCustomClaims(row.firebase_uid, { country });
        assigned += 1;
      }
    }

    console.log(
      `[claims] ${isDryRun ? 'DRY-RUN — nada gravado' : 'aplicado'}: ` +
        `atribuídos=${assigned} já_tinham=${already} sem_conta_idp=${missingAccount}`,
    );
    if (!isDryRun && assigned > 0) {
      console.log('[claims] o claim entra no PRÓXIMO token — quem está logado só vê após refresh (≤1h).');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[claims] falhou:', err);
  process.exit(1);
});
