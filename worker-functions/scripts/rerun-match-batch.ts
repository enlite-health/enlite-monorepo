/**
 * rerun-match-batch.ts
 *
 * Re-roda MatchmakingService.matchWorkersForJob para uma lista fixa de
 * job_posting ids. Use case: vagas criadas durante a janela em que o
 * patient_address.lat/lng estava NULL — o auto-match em setImmediate
 * rodou com coords vazias e nada foi inserido em worker_job_applications.
 * Após o backfill de geocode, basta re-disparar o match.
 *
 * Uso:
 *   npx ts-node -r dotenv/config scripts/rerun-match-batch.ts
 *   npx ts-node -r dotenv/config scripts/rerun-match-batch.ts --dry-run
 *
 * IDs são hardcoded abaixo — edite o array `JOB_IDS` antes de rodar.
 *
 * Segurança:
 *   - Idempotente: saveMatchResults usa ON CONFLICT.
 *   - Sem mutação do schema — só insere em worker_job_applications.
 *   - useScoring=false (default) — não chama Groq / LLM, só hard filter.
 */

import { MatchmakingService } from '../src/modules/matching/infrastructure/MatchmakingService';

const JOB_IDS: string[] = [
  // 760-559 fica fora — user dispara via UI pra validar manualmente
  'aa25bb81-2f36-424a-8496-0e56e976d781', // CASO 760-554
  'a336899a-888c-4670-9215-dc48a5553d47', // CASO 760-544
  'd2aab7a6-f609-4a70-b248-24ac7bad76d2', // CASO 760-541
  '827e6d6f-6d03-494b-b847-16dc8c72e01d', // CASO 759-537
  '564f21ce-b3b6-49da-bf71-13d2b9ccf722', // CASO 760-525
  'b8477e00-82cc-4529-ac8f-4565be40ba42', // CASO 760-520
];

const isDryRun = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  if (JOB_IDS.length === 0) {
    console.error('❌ JOB_IDS está vazio. Edite o array antes de rodar.');
    process.exit(1);
  }

  console.log(
    `[rerun-match-batch] mode=${isDryRun ? 'DRY RUN' : 'EXECUTE'} jobs=${JOB_IDS.length}`,
  );

  if (isDryRun) {
    console.log('IDs que seriam processados:');
    JOB_IDS.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
    return;
  }

  const service = new MatchmakingService();
  const results: Array<{ id: string; ok: boolean; candidates?: number; error?: string }> = [];

  for (const jobId of JOB_IDS) {
    process.stdout.write(`[rerun-match-batch] ${jobId} … `);
    try {
      const r = await service.matchWorkersForJob(jobId, {});
      console.log(`✓ ${r.candidates.length} candidates`);
      results.push({ id: jobId, ok: true, candidates: r.candidates.length });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ ${msg}`);
      results.push({ id: jobId, ok: false, error: msg });
    }
  }

  console.log('\n[rerun-match-batch] DONE');
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  console.log(`  resolved: ${ok.length}/${results.length}`);
  if (ok.length > 0) {
    console.log(`  total candidates inserted: ${ok.reduce((s, r) => s + (r.candidates ?? 0), 0)}`);
  }
  if (failed.length > 0) {
    console.log(`  failed:`);
    failed.forEach((r) => console.log(`    ${r.id} — ${r.error}`));
  }
}

main()
  .catch((err) => {
    console.error('[rerun-match-batch] FATAL:', err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
