/**
 * scripts/iam-config-export.ts — exporta a configuração IAM de um banco para JSON (D208).
 *
 * Grupos vivos (nome, descrição, is_system), células por `recurso:ação`, países
 * vivos, membros por E-MAIL, e overrides de feature por país. Canônico e ordenado:
 * rodar 2× dá o mesmo arquivo (hash impresso). Só leitura. Sem PII além do e-mail
 * de staff; o log mostra contagens.
 *
 * Uso:  DATABASE_URL=<origem> npm run iam:config:export -- --out iam-config.json
 */
import { writeFileSync } from 'fs';
import { Pool } from 'pg';
import { PgIamConfigRepository } from '@modules/identity/permissions/infrastructure/PgIamConfigRepository';
import { canonicalJson, snapshotHash } from '@modules/identity/permissions/application/iamConfig';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions/domain/tenant';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (origem) é obrigatória');
  const out = argValue('--out') ?? 'iam-config.json';
  const pool = new Pool({ connectionString: url });
  try {
    const snap = await new PgIamConfigRepository(pool).exportSnapshot(argValue('--tenant') ?? ENLITE_TENANT_ID);
    writeFileSync(out, canonicalJson(snap));
    console.log(
      `[iam-config] exportado → ${out} · grupos=${snap.groups.length} · vínculos=${snap.groups.reduce((n, g) => n + g.members.length, 0)} · overrides=${snap.countryFeatures.length} · hash=${snapshotHash(snap)}`,
    );
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error('[iam-config] falhou:', e.message); process.exit(1); });
