/**
 * backfill-talentum-prescreening-id.ts — preenche `job_postings.talentum_prescreening_id` (migration 558) lendo
 * `GET /projects/{talentum_project_id}/prescreening` → `_id`. A lógica vive em
 * `src/modules/integration/application/BackfillTalentumPrescreeningId.ts` (testada); aqui só as ligações.
 *
 * Banco: variáveis `PG*` padrão (prd = cloud-sql-proxy). Talentum: `TALENTUM_API_EMAIL`/`TALENTUM_API_PASSWORD`
 * (ou Secret Manager). Outbound na Talentum: só GET (+ login), com contador de métodos no fim.
 *
 *   # DRY-RUN (só GET + relatório; conexão read-only provada):
 *   ts-node -r tsconfig-paths/register scripts/backfill-talentum-prescreening-id.ts --dry-run
 *   # APLICAR (escreve em job_postings — só com autorização nomeada):
 *   ts-node -r tsconfig-paths/register scripts/backfill-talentum-prescreening-id.ts --apply
 */

import { Pool } from 'pg';
import { TalentumApiClient } from '../src/modules/integration/infrastructure/TalentumApiClient';
import { runBackfillCli } from '../src/modules/integration/application/BackfillTalentumPrescreeningId';
import { installFetchMethodCounter } from '../src/modules/integration/application/fetchMethodCounter';

const counter = installFetchMethodCounter();

runBackfillCli(process.argv.slice(2), {
  openDb: (readOnly) =>
    new Pool({ max: 1, options: readOnly ? '-c default_transaction_read_only=on' : undefined }),
  openClient: () => TalentumApiClient.create(),
  httpStats: () => counter.stats(),
  log: (line) => console.log(line),
}).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`ERRO: ${(err as Error).message}`);
    process.exit(1);
  },
);
