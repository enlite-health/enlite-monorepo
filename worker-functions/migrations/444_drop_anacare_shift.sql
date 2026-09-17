-- 444 — Dropa `anacare_shift`, o retrato por TURNO do Ana Care (fecho da F6.4a).
--
-- Por quê: a D361 (17/09) mudou o retrato da lista de por-turno para AGREGADO por paciente+mês
-- (migrations 441/442, `anacare_patient_month`/`anacare_patient_month_provider`). A F6.4a (PR
-- #421, mergeado na stage) já moveu toda leitura e escrita para as tabelas agregadas — medido
-- 17/09: `grep -rn "anacare_shift" worker-functions/src` = 0 (nenhum código de produção lê ou
-- escreve nela). Desde então `anacare_shift` ficou ÓRFÃ no banco: 2.700 linhas que ninguém toca.
--
-- Nota de numeração: a migration **440 nunca existiu** — o PR #417 (que teria sido a 440) foi
-- FECHADO SEM MERGE; a sequência salta de 439 direto para 441. Não é lacuna a preencher.
--
-- Dependências conferidas ANTES desta migration (nenhuma bloqueia o drop):
--   - Nenhuma FK de outra tabela aponta para `anacare_shift` (ela tem FKs SAINDO para
--     `patients`/`workers`, nunca entrando). `shift_hours_validation` (migration 437) religa por
--     chave estável `(source, source_shift_id)`, de propósito, nunca por FK — exatamente para não
--     travar este drop nem sofrer CASCADE.
--   - Nenhuma view (`pg_views`) e nenhuma função (`pg_proc`) referencia `anacare_shift`.
-- `IF EXISTS` para a migration ser re-rodável (idempotente) em qualquer ambiente.

BEGIN;

DROP TABLE IF EXISTS anacare_shift;

COMMIT;
