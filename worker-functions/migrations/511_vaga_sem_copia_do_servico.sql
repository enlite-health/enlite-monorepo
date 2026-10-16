-- Migration 511: vaga com serviço contratado deixa de guardar horário, quantidade e faixa etária (F7, CONTRAIR)
--
-- Change `vaga-le-do-servico-contratado`. Nas fases 1-6 todo leitor passou a buscar horário
-- (`schedule`), quantidade de prestadores (`providers_needed`) e faixa etária (`age_range_min/max`) no
-- SERVIÇO (`patient_contracted_services`) quando a vaga tem `contracted_service_id`, e todo escritor
-- parou de gravar esses 4 campos na vaga com serviço. Esta migration fecha o ciclo no banco:
--
--   1. ESVAZIA a cópia: as 4 colunas viram NULL nas vagas com serviço (o valor mora no serviço).
--   2. PROÍBE a segunda fonte: CHECK `job_postings_service_owns_fields_chk` — vaga com serviço NÃO pode
--      ter valor próprio nas 4 colunas. Quem reabrir uma escrita da cópia leva `23514` no CI e em prd.
--      Vaga MANUAL (sem serviço) segue dona dos 4 campos.
--
-- ⚠️ DEPLOY SEPARADO (EXPAND e CONTRACT em merges distintos, design.md §Ordem expandir → contrair).
-- O runner aplica a migration no BOOT, ANTES de o código novo atender. Com o código ANTIGO ainda no ar
-- (anterior às fases 1-6) uma vaga com serviço ficaria sem horário/quantidade/faixa: o código velho lê a
-- cópia. Por isso esta migration só vai a produção depois de as fases 1-6 estarem deployadas e estáveis,
-- num PR/deploy só dela. Plano de volta: ebrain `openspec/changes/vaga-le-do-servico-contratado/plano-de-volta-f7.md`
-- (drop da constraint + recópia a partir do serviço; o valor antigo DIVERGENTE só volta pelo backup).
--
-- RE-RODÁVEL (rodar 2x não erra e a 2ª não muda nada). Tudo dentro de UM bloco `DO` (atômico mesmo fora do
-- runner, p.ex. `psql -f` do run-migration-prod.sh, que NÃO registra em schema_migrations — memória
-- `migration-manual-precisa-registrar`). Guardas por EXISTÊNCIA (colunas em information_schema, constraint
-- em pg_constraint), nunca por contagem de linhas; DDL/DML via EXECUTE. Se as colunas forem dropadas por
-- uma change futura, a migration vira no-op em vez de quebrar o boot (lição da 266).
--
-- Detalhes:
--  * UPDATE sem lote: produção tem 18 vagas com serviço (Q3 da F0). O gatilho BEFORE UPDATE
--    `update_job_postings_updated_at` (migration 011) renova `updated_at` das vagas tocadas — efeito
--    esperado e único (não há trigger de auditoria em `job_postings`; `job_posting_audit_log` é escrito pela
--    aplicação, não por trigger — este UPDATE NÃO gera linha de auditoria).
--  * NOT VALID + VALIDATE: o UPDATE do passo 1 roda na mesma transação, então o VALIDATE já enxerga a
--    tabela limpa. Se por qualquer razão sobrasse uma vaga com serviço e cópia, o VALIDATE falharia alto
--    e a migration inteira desfaz (é o desejado: nunca constraint "validada" com linha violando).
--  * `lock_timeout` de 10s: o ADD CONSTRAINT pede ACCESS EXCLUSIVE em `job_postings`; esperar sem teto atrás
--    de uma transação longa trava toda leitura de vaga na fila. Estourar o teto falha a migration (boot não
--    sobe, a revisão antiga segue atendendo) — preferível a travar a tabela. Local à transação do bloco.
--  * Índice parcial `idx_job_postings_enrichment_pending` (migration 144, `... AND schedule IS NULL ...`):
--    NÃO trocado aqui (opcional no contrato). Nenhum código o consulta (o CLI de enrichment foi deletado em
--    01/05/2026) e hoje 0 vagas com serviço casam nele (Q8); depois do UPDATE as 18 passam a casar (schedule
--    NULL), o que só aumenta o índice em 18 entradas sem leitor.
--  * Sem objeto novo além da constraint → sem GRANT.

DO $f7$
DECLARE
  v_cols_ok boolean;
BEGIN
  SELECT count(*) = 5 INTO v_cols_ok
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'job_postings'
     AND column_name IN ('schedule', 'providers_needed', 'age_range_min', 'age_range_max', 'contracted_service_id');

  IF NOT v_cols_ok THEN
    RAISE NOTICE 'migration 511: colunas de job_postings ausentes (dropadas por change posterior?) — nada a fazer';
    RETURN;
  END IF;

  PERFORM set_config('lock_timeout', '10s', true);

  -- 1) esvazia a cópia (idempotente: na 2ª passada nenhuma linha casa o WHERE)
  EXECUTE $sql$
    UPDATE job_postings
       SET schedule = NULL, providers_needed = NULL, age_range_min = NULL, age_range_max = NULL
     WHERE contracted_service_id IS NOT NULL
       AND (schedule IS NOT NULL OR providers_needed IS NOT NULL OR age_range_min IS NOT NULL OR age_range_max IS NOT NULL)
  $sql$;

  -- 2) a constraint: criada NOT VALID só se ainda não existe ...
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'job_postings_service_owns_fields_chk'
       AND conrelid = 'public.job_postings'::regclass
  ) THEN
    EXECUTE $sql$
      ALTER TABLE job_postings
        ADD CONSTRAINT job_postings_service_owns_fields_chk
        CHECK (contracted_service_id IS NULL
               OR (schedule IS NULL AND providers_needed IS NULL AND age_range_min IS NULL AND age_range_max IS NULL))
        NOT VALID
    $sql$;
  END IF;

  -- ... e validada só se ainda não está validada (o UPDATE acima já limpou a tabela)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'job_postings_service_owns_fields_chk'
       AND conrelid = 'public.job_postings'::regclass
       AND NOT convalidated
  ) THEN
    EXECUTE 'ALTER TABLE job_postings VALIDATE CONSTRAINT job_postings_service_owns_fields_chk';
  END IF;

  EXECUTE $sql$
    COMMENT ON CONSTRAINT job_postings_service_owns_fields_chk ON job_postings IS
      'F7 (vaga-le-do-servico-contratado): vaga com serviço contratado NÃO guarda horário, quantidade nem faixa etária — o valor mora em patient_contracted_services. Vaga manual (contracted_service_id NULL) segue dona dos 4 campos.'
  $sql$;
END
$f7$;
