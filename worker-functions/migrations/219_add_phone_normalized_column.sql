-- Migration 219: coluna phone_normalized + índice de unicidade semântica
--
-- PROBLEMA:
--   workers.phone armazena números em formatos históricos variados:
--     '1151265663'         (10 dígitos, sem prefixo)
--     '541151265663'       (12 dígitos, sem o 9 do móvel)
--     '5491151265663'      (13 dígitos — canônico BA)
--   Isso causa duplicatas semânticas: 3 registros de phone diferente
--   mas mesma pessoa, sem constraint impedindo novos inserts.
--
-- SOLUÇÃO:
--   Coluna gerada phone_normalized que aplica a mesma lógica de
--   normalizePhoneAR (TypeScript) diretamente no banco.
--   Índice UNIQUE parcial impede duplicatas semânticas futuras.
--   Registros existentes duplicados são tratados na migration 220.
--
-- REGRAS DE NORMALIZAÇÃO (espelhando normalizePhoneAR):
--   10 dígitos               → '549' || digits
--   11 dígitos, começa '54'  → '549' || substr(digits, 3)
--   12 dígitos, começa '54', não '549' → '549' || substr(digits, 3)
--   13 dígitos, começa '549' → digits (já canônico)
--   Outros                   → digits (comprimento incomum, sem tocar)
--   Vazio/NULL               → NULL
--
-- NOTA SOBRE FORMATO COM '+':
--   phone pode ter o prefixo '+' (ex: '+5491155261243').
--   A normalização remove o '+' antes de aplicar as regras.
--
-- IDEMPOTÊNCIA:
--   Toda instrução usa IF NOT EXISTS / OR REPLACE / CREATE INDEX IF NOT EXISTS.

-- ── Função auxiliar de normalização (PL/pgSQL, espelha normalizePhoneAR) ──────

CREATE OR REPLACE FUNCTION normalize_phone_ar(raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  digits TEXT;
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;

  -- Remove todos os não-dígitos (inclui '+', espaços, hífens)
  digits := regexp_replace(raw, '[^0-9]', '', 'g');

  IF digits = '' THEN
    RETURN NULL;
  END IF;

  -- 10 dígitos → falta país + móvel → prepend '549'
  IF length(digits) = 10 THEN
    RETURN '549' || digits;
  END IF;

  -- 11 dígitos começando com '54' → falta o '9' → '549' + rest
  IF length(digits) = 11 AND digits LIKE '54%' THEN
    RETURN '549' || substr(digits, 3);
  END IF;

  -- 12 dígitos começando com '54' mas não '549' → idem
  IF length(digits) = 12 AND digits LIKE '54%' AND digits NOT LIKE '549%' THEN
    RETURN '549' || substr(digits, 3);
  END IF;

  -- 13 dígitos começando com '549' → já canônico
  IF length(digits) = 13 AND digits LIKE '549%' THEN
    RETURN digits;
  END IF;

  -- Comprimentos incomuns (8, 9, 14+): retorna dígitos sem formatação
  RETURN digits;
END;
$$;

COMMENT ON FUNCTION normalize_phone_ar(TEXT) IS
  'Espelha normalizePhoneAR (src/shared/utils/phoneNormalization.ts). '
  'Normaliza telefones argentinos para o formato canônico 549XXXXXXXXXX. '
  'Retorna NULL para entrada vazia/nula. IMMUTABLE e PARALLEL SAFE — '
  'pode ser usada em colunas geradas e índices.';

-- ── Coluna gerada phone_normalized ────────────────────────────────────────────

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS phone_normalized TEXT
    GENERATED ALWAYS AS (normalize_phone_ar(phone)) STORED;

COMMENT ON COLUMN workers.phone_normalized IS
  'Coluna gerada: normalizePhoneAR(phone) aplicado no banco via normalize_phone_ar(). '
  'NULL quando phone é nulo ou vazio. Usada pelo índice UNIQUE parcial '
  'idx_workers_phone_normalized_unique para impedir duplicatas semânticas futuras. '
  'Não gravar diretamente — é GENERATED ALWAYS.';

-- ── Índice NÃO-único (suporte ao merge e a buscas por phone_normalized) ───────
-- ATENÇÃO: o índice UNIQUE de unicidade semântica foi MOVIDO para a migration 222.
-- Ele NÃO pode ser criado aqui porque (a) há duplicatas semânticas pré-existentes
-- (~137 grupos) que fariam a criação falhar antes do merge, e (b) ligar a constraint
-- em prod antes do código de normalização (WorkerRepository.create) deployar poderia
-- derrubar o cadastro de novos workers. A 222 entra junto com o deploy do código.

CREATE INDEX IF NOT EXISTS idx_workers_phone_normalized
  ON workers (phone_normalized)
  WHERE phone_normalized IS NOT NULL
    AND merged_into_id IS NULL;

COMMENT ON INDEX idx_workers_phone_normalized IS
  'Índice de suporte (NÃO-único) para o merge service e buscas por phone_normalized. '
  'A unicidade semântica é imposta pela migration 222 (idx_workers_phone_normalized_unique), '
  'aplicada APÓS o merge eliminar as duplicatas e junto do deploy do código de prevenção.';

DO $$ BEGIN
  RAISE NOTICE 'Migration 219 concluída: função normalize_phone_ar, coluna phone_normalized e índice (não-único) criados';
END $$;
