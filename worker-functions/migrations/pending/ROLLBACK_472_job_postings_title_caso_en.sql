-- ROLLBACK_472_job_postings_title_caso_en.sql — par de rollback da migration 472
-- (título de vaga de caso nativo passa a "CASO EN{n}-{m}", spec 028, D422).
--
-- QUANDO USAR: regressão detectada depois do deploy da 472 em prd — por exemplo,
-- algum leitor externo (ClickUp, Talentum, export) quebrando por não reconhecer o
-- prefixo "EN" no título, ou decisão de reverter D422 antes de outro fix mais
-- específico ficar pronto.
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js`
-- lista `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem
-- numérica — um `473_rollback_*.sql` seria aplicado automaticamente na PRÓXIMA corrida
-- do runner (e2e, boot do Cloud Run, ou `run-migration-prod.sh` batendo em `migrations/`
-- inteira), desfazendo a 472 sem ninguém ter pedido. `migrations/pending/` é o único
-- lugar que o runner ignora (ver `migrations/pending/README.md`) — o arquivo fica
-- escrito, revisado e versionado, mas só roda quando alguém aponta o caminho
-- explicitamente.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_472_job_postings_title_caso_en.sql
--
-- O QUE FAZ: restaura `title` a partir do backup em `title_before_en` — NÃO dropa a
-- coluna (SUP-5 do plano: preserva o backup mesmo depois de reverter, para o caso de
-- precisar reaplicar ou auditar depois). Só toca linha que a 472 de fato reescreveu
-- (`title_before_en IS NOT NULL`); reexecução é idempotente (2ª corrida não muda nada,
-- porque `title` já bate com `title_before_en`).

UPDATE job_postings
   SET title = title_before_en
 WHERE title_before_en IS NOT NULL
   AND title <> title_before_en;
