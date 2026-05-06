/**
 * rewrap-encrypted-passthrough.ts
 *
 * Re-grava todas as colunas *_encrypted do DB local que estão cifradas com
 * Cloud KMS real (típico de snapshots de produção) em formato "passthrough":
 * base64(plaintext_utf8). Depois disso, o backend rodando com
 * USE_KMS_ENCRYPTION=false consegue ler os valores corretamente.
 *
 * Heurística por linha:
 *  - Tenta KMS.decrypt(value) usando creds GCP reais.
 *  - Se OK: re-grava como base64(plaintext) (formato passthrough).
 *  - Se INVALID_ARGUMENT: assume que já está em passthrough → skip.
 *  - Outros erros: log e segue.
 *
 * Idempotente: rodar de novo é seguro — linhas já em passthrough caem no skip.
 *
 * ── Pré-requisitos ──────────────────────────────────────────────────────────
 *   - gcloud auth application-default login
 *   - Conta com permissão roles/cloudkms.cryptoKeyDecrypter na chave de prod
 *   - Postgres local rodando (docker compose up postgres)
 *
 * ── Como executar ───────────────────────────────────────────────────────────
 *   GCP_PROJECT_ID=enlite-prd \
 *   GCP_REGION=southamerica-west1 \
 *   KMS_KEYRING=enlite-keyring \
 *   KMS_KEY_NAME=worker-data-key \
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e \
 *   npx ts-node scripts/rewrap-encrypted-passthrough.ts
 */
import { Pool } from 'pg';
import { KeyManagementServiceClient } from '@google-cloud/kms';

interface TableSpec {
  table: string;
  pk: string;
  columns: string[];
}

const TABLES: TableSpec[] = [
  {
    table: 'workers',
    pk: 'id',
    columns: [
      'first_name_encrypted',
      'last_name_encrypted',
      'birth_date_encrypted',
      'sex_encrypted',
      'gender_encrypted',
      'phone_encrypted',
      'email_encrypted',
      'document_number_encrypted',
      'profile_photo_url_encrypted',
      'languages_encrypted',
      'sexual_orientation_encrypted',
      'race_encrypted',
      'religion_encrypted',
      'weight_kg_encrypted',
      'height_cm_encrypted',
      'linkedin_url_encrypted',
      'whatsapp_phone_encrypted',
    ],
  },
  { table: 'encuadres', pk: 'id', columns: ['worker_email_encrypted'] },
  {
    table: 'patient_professionals',
    pk: 'id',
    columns: ['phone_encrypted', 'email_encrypted'],
  },
  {
    table: 'blacklist',
    pk: 'id',
    columns: ['reason_encrypted', 'detail_encrypted'],
  },
  {
    table: 'patient_responsibles',
    pk: 'id',
    columns: ['phone_encrypted', 'email_encrypted', 'document_number_encrypted'],
  },
];

interface ColumnStats {
  total: number;
  rewrapped: number;
  alreadyPassthrough: number;
  failed: number;
}

function assertLocalDatabase(databaseUrl: string): void {
  const lower = databaseUrl.toLowerCase();
  const isLocal =
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('@postgres:') ||
    lower.includes('@postgres/');

  if (!isLocal) {
    console.error(
      '[rewrap] DATABASE_URL não aponta para localhost/127.0.0.1/postgres — abortando por segurança.',
    );
    console.error(`[rewrap] Recebido: ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);
    process.exit(1);
  }
}

async function rewrapColumn(
  pool: Pool,
  kms: KeyManagementServiceClient,
  keyName: string,
  spec: { table: string; pk: string; column: string },
): Promise<ColumnStats> {
  const { table, pk, column } = spec;
  const stats: ColumnStats = {
    total: 0,
    rewrapped: 0,
    alreadyPassthrough: 0,
    failed: 0,
  };

  const { rows } = await pool.query<{ id: string; value: string }>(
    `SELECT ${pk} AS id, ${column} AS value
       FROM ${table}
      WHERE ${column} IS NOT NULL AND ${column} <> ''`,
  );
  stats.total = rows.length;

  for (const row of rows) {
    try {
      const [result] = await kms.decrypt({
        name: keyName,
        ciphertext: Buffer.from(row.value, 'base64'),
      });
      const plaintext = Buffer.from(result.plaintext || '').toString('utf8');
      const passthrough = Buffer.from(plaintext, 'utf8').toString('base64');

      if (passthrough === row.value) {
        stats.alreadyPassthrough++;
        continue;
      }

      await pool.query(
        `UPDATE ${table} SET ${column} = $1 WHERE ${pk} = $2`,
        [passthrough, row.id],
      );
      stats.rewrapped++;
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      const isInvalidCiphertext =
        e?.code === 3 ||
        /INVALID_ARGUMENT|invalid ciphertext|Decryption failed/i.test(e?.message ?? '');
      if (isInvalidCiphertext) {
        stats.alreadyPassthrough++;
        continue;
      }
      console.error(
        `[rewrap] ${table}.${column} ${row.id}: ${e?.message ?? String(err)}`,
      );
      stats.failed++;
    }
  }

  return stats;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[rewrap] DATABASE_URL não setada.');
    process.exit(1);
  }
  assertLocalDatabase(databaseUrl);

  const projectId = process.env.GCP_PROJECT_ID || 'enlite-prd';
  const location = process.env.GCP_REGION || 'southamerica-west1';
  const keyRing = process.env.KMS_KEYRING || 'enlite-keyring';
  const keyName = process.env.KMS_KEY_NAME || 'worker-data-key';

  const kms = new KeyManagementServiceClient();
  const fullKeyName = kms.cryptoKeyPath(projectId, location, keyRing, keyName);
  console.log(`[rewrap] usando chave KMS: ${fullKeyName}`);

  const pool = new Pool({ connectionString: databaseUrl });

  let totalRewrapped = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const { table, pk, columns } of TABLES) {
    for (const column of columns) {
      const stats = await rewrapColumn(pool, kms, fullKeyName, {
        table,
        pk,
        column,
      });
      console.log(
        `[rewrap] ${table}.${column}: total=${stats.total} rewrapped=${stats.rewrapped} skipped=${stats.alreadyPassthrough} failed=${stats.failed}`,
      );
      totalRewrapped += stats.rewrapped;
      totalSkipped += stats.alreadyPassthrough;
      totalFailed += stats.failed;
    }
  }

  await pool.end();

  console.log(
    `[rewrap] DONE — rewrapped=${totalRewrapped} skipped=${totalSkipped} failed=${totalFailed}`,
  );
  if (totalFailed > 0) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[rewrap] FATAL:', err);
  process.exit(1);
});
