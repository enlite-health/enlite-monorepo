-- 434 (CONTRACT) — `patient_addresses`: apaga o valor legado de `address_type` em linha ATIVA e
-- aperta a lista fechada por parentesco (spec 019; D310 item c; override do `lex` 12/09/2026)
--
-- ── Pré-condição desta migration ──────────────────────────────────────────────
-- Só roda DEPOIS que a 433 (expand) já rodou E o código novo (que passa a ler `is_default` em
-- vez de `address_type = 'primary'`, e para de escrever `address_type` no create — ver
-- tasks.md §2) já está publicado. Rodar esta migration ANTES do deploy do código novo quebra a
-- revisão velha: ela ainda tenta escrever `address_type = 'primary'`/`'secondary'`, e o CHECK
-- novo (passo 7) rejeitaria esse valor em linha ativa.
--
-- ── Por que reexecutar o backfill do passo 2 aqui ─────────────────────────────
-- Entre a 433 rodar e o código novo subir, a revisão VELHA continua no ar (deploy do Cloud Run é
-- gradual) e pode ter inserido/atualizado linhas com `address_type = 'primary'` que a 433 não viu
-- (rodou antes dela existir). Sem repetir o backfill aqui, ANTES do passo 5 apagar o valor
-- legado, essas linhas perderiam a chance de virar `is_default = true` — o mesmo risco que a
-- ordem "is_default antes de NULL" da spec.md existe para evitar, agora reaplicado à janela
-- entre as duas migrations, não só dentro de uma.
--
-- ── O que esta migration faz (passos 5, 7 e 8 da ordem da spec.md) ────────────
-- 0. Backfill idempotente (repetição do passo 2 da 433) — cobre linha escrita pelo código velho
--    na janela entre as duas migrations.
-- 5. `UPDATE address_type = NULL` só em linhas ATIVAS. Arquivadas (`archived_at IS NOT NULL`)
--    NUNCA são tocadas — retêm o valor legado para sempre (guarda de 10 anos, Ley 26.529 art.
--    18, tensão aberta na OP-04).
-- 7. CHECK da lista fechada por parentesco, com escape `archived_at IS NOT NULL OR ...` — sem
--    ele, a primeira linha arquivada com valor legado (fora da lista nova) reprova o CHECK e a
--    migration inteira falha.
-- 8. CHECK de coerência do texto livre do "Otro" — só faz sentido com `address_type = 'otro'`,
--    mesmo escape de arquivada.
--
-- **Proibida** qualquer coluna `address_type_legacy` ou equivalente (OP-04 Emenda 29/08 item e:
-- "nenhuma segunda cópia"). O valor antigo não é copiado para lugar nenhum — só deixa de ser
-- escrito nas linhas ativas. Valor novo só entra por PATCH humano, um endereço de cada vez.
--
-- ── ORDEM DE EXECUÇÃO desta entrega (dura, retomada da 433) ───────────────────
--   1. migrations/433_patient_addresses_is_default_expand.sql (expand — já aplicada)
--   2. deploy do código novo (is_default na leitura, address_type fora do create — tasks.md §2)
--   3. esta migration (434, contract)
--
-- Rollback: reversão desta migration sozinha é DESTRUTIVA por desenho — o passo 5 apaga o valor
-- legado de `address_type` em linha ativa sem guardar cópia em lugar nenhum (é o ponto central
-- do desenho: nenhuma segunda cópia). Não há como recuperar esse valor depois. Se for preciso
-- reverter:
--   ALTER TABLE patient_addresses DROP CONSTRAINT IF EXISTS
--     patient_addresses_type_other_coherence;
--   ALTER TABLE patient_addresses DROP CONSTRAINT IF EXISTS patient_addresses_type_check;
--   -- o UPDATE do passo 5 NÃO é reversível — a linha ativa fica com address_type = NULL para
--   -- sempre, a menos que alguém repovoe manualmente a partir de outra fonte (ex.: ClickUp).
-- Reverter também a 433 (expand) depois desta exige DROP COLUMN/INDEX na ordem inversa dela —
-- ver o cabeçalho da 433.
--
-- ── GRANT ao `enlite_mcp_ro` ───────────────────────────────────────────────────
-- Nenhum GRANT nesta migration — mesmo motivo da 433: `patient_addresses` ainda tem SELECT de
-- tabela inteira via `pg_read_all_data` em prd e stage (medido 12/09). Negar
-- `address_type`/`address_type_other` é `scripts/create-mcp-ro-role.sql` (B1, Etapa 2, arquivo
-- separado).

BEGIN;

-- 0. Re-backfill idempotente — cobre linha escrita pelo código velho entre a 433 e o deploy.
--    ANTES do passo 5, pelo mesmo motivo da 433: is_default precisa estar preenchido antes de
--    address_type ser apagado.
UPDATE patient_addresses
   SET is_default = true
 WHERE address_type = 'primary'
   AND archived_at IS NULL
   AND is_default = false;

-- 5. Apaga o valor legado só das linhas ATIVAS. Idempotente (WHERE já filtra o que falta
--    apagar) — rodar duas vezes não faz diferença na segunda.
UPDATE patient_addresses
   SET address_type = NULL
 WHERE archived_at IS NULL
   AND address_type IS NOT NULL;

-- 7. Lista fechada do tipo por parentesco. Escape `archived_at IS NOT NULL OR ...`: sem ele, a
--    primeira linha arquivada com valor legado (`primary`/`secondary`/`tertiary`, fora da lista
--    nova) reprova o CHECK e a migration inteira falha.
ALTER TABLE patient_addresses
  DROP CONSTRAINT IF EXISTS patient_addresses_type_check;
ALTER TABLE patient_addresses
  ADD CONSTRAINT patient_addresses_type_check
  CHECK (
    archived_at IS NOT NULL
    OR address_type IS NULL
    OR address_type IN (
      'domicilio_propio', 'casa_madre', 'casa_padre', 'casa_abuela',
      'casa_abuelo', 'escuela', 'trabajo', 'otro'
    )
  );

-- 8. Coerência do texto livre: só faz sentido junto de `address_type = 'otro'`. Mesmo escape de
--    arquivada, pelo mesmo motivo do passo 7.
ALTER TABLE patient_addresses
  DROP CONSTRAINT IF EXISTS patient_addresses_type_other_coherence;
ALTER TABLE patient_addresses
  ADD CONSTRAINT patient_addresses_type_other_coherence
  CHECK (
    archived_at IS NOT NULL
    OR address_type_other IS NULL
    OR address_type = 'otro'
  );

COMMENT ON COLUMN patient_addresses.address_type IS
  'REAPROVEITADA (spec 019, Caminho B, override do lex 12/09/2026): tipo de LOCAL por '
  'parentesco — domicilio_propio | casa_madre | casa_padre | casa_abuela | casa_abuelo | '
  'escuela | trabajo | otro, NULL = sin especificar. Em linha ATIVA, valor legado '
  '(primary/secondary/tertiary) foi apagado pela migration 434 e NUNCA é inferido — só entra '
  'por PATCH humano. Em linha ARQUIVADA retém o valor legado para sempre (guarda de 10 anos, '
  'Ley 26.529 art. 18) — os CHECKs desta tabela escapam archived_at IS NOT NULL por isso. '
  'Migrations 433 (expand) + 434 (contract).';
COMMENT ON COLUMN patient_addresses.address_type_other IS
  'Texto livre do tipo "Otro" (≤ 40 caracteres, CHECK de tamanho na migration 433), coerente '
  'com address_type = ''otro'' em linha ativa desde a migration 434 '
  '(patient_addresses_type_other_coherence). Dado sensível sobre a família do paciente.';

COMMIT;
