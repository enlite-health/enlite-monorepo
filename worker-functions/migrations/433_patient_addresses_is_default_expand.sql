-- 433 (EXPAND) — `patient_addresses`: marca de PRINCIPAL própria (`is_default`) + coluna nova
-- `address_type_other` (spec 019; D310 item c; override do `lex` 12/09/2026 — ver spec.md
-- "Override do lex")
--
-- ── Por que expand/contract em DOIS arquivos, e não um só ────────────────────
-- Migration e deploy do código são atos MANUAIS separados neste repo (`scripts/
-- run-migration-stg.sh`/`run-migration-prod.sh`, rodados à mão — nenhum workflow de CI aplica
-- migration na stage nem em prd; medido 12/09). Não existe garantia de janela zero entre
-- "migration aplicada" e "código novo no ar". Uma migration só que já REJEITA o valor legado
-- (CHECK da lista fechada) quebraria qualquer INSERT/UPDATE do código VELHO que ainda estiver
-- de pé escrevendo `address_type = 'primary'`/`'secondary'` — o mesmo motivo da migration 332
-- (rename em duas fases do `worker_blocked_applications`).
--
-- Esta migration (433) é só ADITIVA: nada aqui rejeita nada que o código velho já escreve.
-- Roda ANTES do deploy do código novo. A 434 (CONTRACT) é quem apaga o valor legado das linhas
-- ativas e aperta os CHECKs — só depois que o código novo (que já não escreve `address_type` no
-- create e usa `is_default`) estiver publicado.
--
-- ── O que esta migration faz ──────────────────────────────────────────────────
-- 1. `is_default boolean NOT NULL DEFAULT false` — aditiva, todas as linhas.
-- 2. Backfill: `is_default = true` onde `address_type = 'primary' AND archived_at IS NULL`
--    (medido 12/09: stage tem 328 `primary`/328 `secondary` ativos, 0 pacientes com mais de 1
--    `primary` ativo — nenhum conflito de unicidade esperado).
-- 3. Índice único parcial `(patient_id) WHERE is_default AND archived_at IS NULL` — no máximo um
--    principal ativo por paciente. Não há CHECK/enum/trigger hoje sobre `address_type` em prd
--    nem stage (medido) — este índice é a primeira trava de unicidade que a coluna ganha.
-- 4. `address_type` perde o `NOT NULL` — precisa acontecer antes da 434 poder gravar `NULL`.
-- 6. `address_type_other text NULL` com CHECK de tamanho (≤ 40) — coluna nova, ninguém lê nem
--    escreve nela ainda (o código que a usa só chega com a 434 + o deploy). CHECK de tamanho
--    entra aqui porque não depende de nenhum valor legado existente.
--
-- Os passos 5 (apagar valor legado ativo), 7 (CHECK da lista fechada) e 8 (CHECK de coerência
-- do "Otro") ficam na 434 — de propósito: rejeitar valor legado antes do código parar de
-- escrevê-lo quebraria a revisão velha em produção durante a janela do deploy.
--
-- ── Linha ARQUIVADA nunca é tocada ────────────────────────────────────────────
-- `archived_at IS NOT NULL` fica de fora do backfill (2) — arquivada não teve escolha de
-- principal e não deve ganhar uma por dedução. Retém o valor legado para sempre (guarda de 10
-- anos, Ley 26.529 art. 18, OP-04).
--
-- ── ORDEM DE EXECUÇÃO desta entrega (dura) ────────────────────────────────────
--   1. esta migration (433, expand — aditiva)
--   2. deploy do código que passa a usar `is_default` na leitura e para de escrever
--      `address_type` no create (`AdminPatientsController.ts`, `ClickUpPatientMapper.ts`,
--      `PatientRelatedWriter.ts` etc. — ver tasks.md §2)
--   3. `migrations/434_patient_addresses_address_type_contract.sql` (re-backfill idempotente de
--      `is_default` para cobrir linha escrita pelo código velho na janela + apaga valor legado
--      ativo + aperta os CHECKs)
--
-- Rollback desta migration (433), enquanto a 434 não tiver rodado: reversível sem perda —
--   DROP INDEX IF EXISTS patient_addresses_one_default_per_patient;
--   ALTER TABLE patient_addresses DROP CONSTRAINT IF EXISTS
--     patient_addresses_address_type_other_len;
--   ALTER TABLE patient_addresses DROP COLUMN IF EXISTS address_type_other;
--   ALTER TABLE patient_addresses DROP COLUMN IF EXISTS is_default;
--   -- address_type volta a exigir NOT NULL só se toda linha ainda tiver valor (verdade até a
--   -- 434 rodar, porque esta migration não apaga nada em linha ativa):
--   ALTER TABLE patient_addresses ALTER COLUMN address_type SET NOT NULL;
-- Depois que a 434 rodar, o rollback da 433 sozinho não faz mais sentido (o valor legado ativo
-- já foi apagado por ela) — reverter as duas juntas, na ordem 434 depois 433.
--
-- ── GRANT ao `enlite_mcp_ro` ───────────────────────────────────────────────────
-- Nenhum GRANT nesta migration. `patient_addresses` ainda tem SELECT de TABELA INTEIRA para
-- `enlite_mcp_ro` (medido 12/09: sem CHECK/enum/trigger, membership `pg_read_all_data`, 0/19
-- colunas com ACL própria, tanto em prd quanto em stage — `create-mcp-ro-role.sql` nunca
-- rodou). Coluna nova herda o mesmo acesso de tabela inteira que toda coluna de
-- `patient_addresses` já tem (mesmo padrão de `logistics_corridor`/`access_notes`/`country`,
-- migration 316). Negar `address_type`/`address_type_other` é o array `excluir` de
-- `scripts/create-mcp-ro-role.sql` — arquivo separado, B1 da Etapa 2, fora desta migration.

BEGIN;

-- 1. `is_default` — aditiva, todas as linhas nascem `false`.
ALTER TABLE patient_addresses
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- 2. Backfill inicial: só ativas, só a partir do valor legado `primary`. Idempotente (WHERE já
--    filtra o que falta; reexecutar não desmarca nada, porque só liga `true`).
--    ⚠️ Este backfill roda de novo, idempotente, no início da 434 — para cobrir qualquer linha
--    que o código VELHO ainda tenha inserido/atualizado com `address_type = 'primary'` durante a
--    janela entre esta migration e o deploy do código novo.
UPDATE patient_addresses
   SET is_default = true
 WHERE address_type = 'primary'
   AND archived_at IS NULL
   AND is_default = false;

-- 3. No máximo um principal ativo por paciente — índice único parcial. Medido 12/09 (stage): 0
--    pacientes com mais de 1 `primary` ativo — nenhum conflito esperado ao criar o índice.
DROP INDEX IF EXISTS patient_addresses_one_default_per_patient;
CREATE UNIQUE INDEX patient_addresses_one_default_per_patient
  ON patient_addresses (patient_id)
  WHERE is_default AND archived_at IS NULL;

-- 4. `address_type` deixa de ser obrigatória — precondição da 434, que vai gravar NULL nela.
--    Não muda nenhum valor existente.
ALTER TABLE patient_addresses ALTER COLUMN address_type DROP NOT NULL;

-- 6. Texto livre do "Otro" — coluna nova, ninguém escreve ainda (código novo chega só com o
--    deploy + a 434). CHECK de tamanho não depende de dado legado, entra aqui.
ALTER TABLE patient_addresses
  ADD COLUMN IF NOT EXISTS address_type_other text NULL;

ALTER TABLE patient_addresses
  DROP CONSTRAINT IF EXISTS patient_addresses_address_type_other_len;
ALTER TABLE patient_addresses
  ADD CONSTRAINT patient_addresses_address_type_other_len
  CHECK (char_length(address_type_other) <= 40);

COMMENT ON COLUMN patient_addresses.is_default IS
  'Marca de PRINCIPAL própria da operação (spec 019) — não mais deduzida de address_type = '
  '''primary'' (posição do slot no ClickUp). No máximo uma ativa por paciente (índice único '
  'parcial patient_addresses_one_default_per_patient). Migration 433 (expand) + 434 (contract, '
  're-backfill).';
COMMENT ON COLUMN patient_addresses.address_type_other IS
  'Texto livre do tipo "Otro" (≤ 40 caracteres) — spec 019. Só passa a ser coerente com '
  'address_type = ''otro'' depois da migration 434 (contract), que grava o CHECK de coerência. '
  'Dado sensível sobre a família do paciente. Migration 433.';

COMMIT;
