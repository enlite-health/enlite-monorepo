/**
 * reconcile-talentum-v2.ts — spec 040 / F5 (decisão (b)): religa as vagas de `job_postings` aos projetos da
 * Talentum v2 (por `publicId`, depois por título 1:1) e troca o link `wa.me` pelo link web.
 * A lógica vive em `src/modules/integration/application/ReconcileTalentumV2*.ts` (testada); aqui só as ligações.
 *
 * Banco: variáveis `PG*` padrão (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE; prd = cloud-sql-proxy, ver a
 * memória acesso-operacional-prod). Talentum: `TALENTUM_API_EMAIL`/`TALENTUM_API_PASSWORD` (ou Secret Manager).
 * Dry-run força `default_transaction_read_only=on` na conexão.
 *
 *   # DRY-RUN (padrão, só leitura; --csv-out grava o rollback que SERIA usado):
 *   ts-node -r tsconfig-paths/register scripts/reconcile-talentum-v2.ts [--csv-out <csv>]
 *   # EXECUTAR (escreve em job_postings — só com autorização nomeada):
 *   ts-node -r tsconfig-paths/register scripts/reconcile-talentum-v2.ts --execute --csv-out <csv novo>
 *   # DESFAZER:
 *   ts-node -r tsconfig-paths/register scripts/reconcile-talentum-v2.ts --rollback <csv>
 */

import fs from 'fs';
import { Pool } from 'pg';
import { TalentumApiClient } from '../src/modules/integration/infrastructure/TalentumApiClient';
import { runReconcileCli } from '../src/modules/integration/application/ReconcileTalentumV2Cli';
import { installFetchMethodCounter } from '../src/modules/integration/application/fetchMethodCounter';

const counter = installFetchMethodCounter();

runReconcileCli(process.argv.slice(2), {
  openDb: (readOnly) =>
    new Pool({ max: 1, options: readOnly ? '-c default_transaction_read_only=on' : undefined }),
  openClient: () => TalentumApiClient.create(),
  fs: {
    exists: (p) => fs.existsSync(p),
    write: (p, text) => fs.writeFileSync(p, text, { flag: 'wx', mode: 0o600 }),
    read: (p) => fs.readFileSync(p, 'utf8'),
  },
  httpStats: () => counter.stats(),
  log: (line) => console.log(line),
}).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`ERRO: ${(err as Error).message}`);
    process.exit(1);
  },
);
