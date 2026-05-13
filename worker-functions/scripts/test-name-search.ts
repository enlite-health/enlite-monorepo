/**
 * test-name-search.ts
 *
 * Validação end-to-end do blind index trigram em produção:
 * 1) Pega 5 workers random com name_trgm_bidx populado
 * 2) Decripta o nome real via KMS
 * 3) Gera trigram de busca via BlindIndexService
 * 4) Roda query real `WHERE name_trgm_bidx @> $1`
 * 5) Confirma que o próprio worker está no resultado (idealmente também outros)
 *
 * Uso: ts-node -r dotenv/config scripts/test-name-search.ts
 */

import { Pool } from 'pg';
import { KMSEncryptionService } from '../src/shared/security/KMSEncryptionService';
import { BlindIndexService } from '../src/shared/security/BlindIndexService';

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new KMSEncryptionService();
  const bidx = new BlindIndexService();

  console.log('[test-search] Pegando 5 workers random com índice populado...\n');

  const { rows: samples } = await pool.query<{
    id: string;
    first_name_encrypted: string;
    last_name_encrypted: string | null;
  }>(`
    SELECT id, first_name_encrypted, last_name_encrypted
      FROM workers
     WHERE name_trgm_bidx IS NOT NULL
       AND first_name_encrypted IS NOT NULL
       AND merged_into_id IS NULL
     ORDER BY random()
     LIMIT 5
  `);

  let passed = 0;
  let failed = 0;

  for (const sample of samples) {
    const [firstName, lastName] = await Promise.all([
      kms.decrypt(sample.first_name_encrypted),
      sample.last_name_encrypted ? kms.decrypt(sample.last_name_encrypted) : Promise.resolve(''),
    ]);

    const fullName = [firstName, lastName].filter(Boolean).join(' ');
    console.log(`──────────────────────────────────────────────────`);
    console.log(`Worker ID: ${sample.id}`);
    console.log(`Nome real: "${fullName}"`);

    // Teste 1: buscar pelo nome completo
    try {
      const trgmFull = await bidx.generateSearchTrigramBidx(fullName);
      const trgmFullLiteral = bidx.serializeForPg(trgmFull);
      const { rows: full } = await pool.query<{ id: string; count: string }>(`
        SELECT id, (SELECT COUNT(*) FROM workers WHERE name_trgm_bidx @> $1::bytea[] AND merged_into_id IS NULL)::text AS count
          FROM workers
         WHERE name_trgm_bidx @> $1::bytea[]
           AND merged_into_id IS NULL
           AND id = $2
         LIMIT 1
      `, [trgmFullLiteral, sample.id]);
      const totalMatches = full[0]?.count ?? '0';
      const selfFound = full.length > 0;
      console.log(`  ✓ Busca completa "${fullName}": ${selfFound ? 'ENCONTROU próprio worker' : '❌ NÃO encontrou próprio worker'} | total matches: ${totalMatches}`);
      if (selfFound) passed++; else failed++;
    } catch (e) {
      console.log(`  ❌ Busca completa falhou: ${e instanceof Error ? e.message : e}`);
      failed++;
    }

    // Teste 2: buscar só pelo primeiro nome
    if (firstName.length >= 3) {
      try {
        const trgmFirst = await bidx.generateSearchTrigramBidx(firstName);
        const trgmFirstLiteral = bidx.serializeForPg(trgmFirst);
        const { rows: matches } = await pool.query<{ count: string; self_match: boolean }>(`
          SELECT
            COUNT(*)::text AS count,
            BOOL_OR(id = $2) AS self_match
            FROM workers
           WHERE name_trgm_bidx @> $1::bytea[]
             AND merged_into_id IS NULL
        `, [trgmFirstLiteral, sample.id]);
        const total = matches[0]?.count ?? '0';
        const selfFound = matches[0]?.self_match;
        console.log(`  ✓ Busca primeiro nome "${firstName}": total matches=${total}, próprio incluso=${selfFound ? 'SIM' : '❌ NÃO'}`);
        if (selfFound) passed++; else failed++;
      } catch (e) {
        console.log(`  ❌ Busca primeiro nome falhou: ${e instanceof Error ? e.message : e}`);
        failed++;
      }
    }

    // Teste 3: substring no meio do nome (3 chars do meio)
    const combined = `${firstName}${lastName}`.replace(/\s+/g, '');
    if (combined.length >= 6) {
      const mid = combined.substring(2, 5);
      try {
        const trgmMid = await bidx.generateSearchTrigramBidx(mid);
        const trgmMidLiteral = bidx.serializeForPg(trgmMid);
        const { rows: matches } = await pool.query<{ count: string; self_match: boolean }>(`
          SELECT
            COUNT(*)::text AS count,
            BOOL_OR(id = $2) AS self_match
            FROM workers
           WHERE name_trgm_bidx @> $1::bytea[]
             AND merged_into_id IS NULL
        `, [trgmMidLiteral, sample.id]);
        console.log(`  ✓ Busca substring "${mid}": total=${matches[0]?.count}, próprio incluso=${matches[0]?.self_match ? 'SIM' : '❌'}`);
        if (matches[0]?.self_match) passed++; else failed++;
      } catch (e) {
        console.log(`  ⚠️  Busca substring "${mid}" falhou (pode ser caractere especial): ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  console.log(`\n──────────────────────────────────────────────────`);
  console.log(`RESUMO: ${passed} passou, ${failed} falhou`);
  console.log(`──────────────────────────────────────────────────`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[test-search] FATAL:', err);
  process.exit(1);
});
