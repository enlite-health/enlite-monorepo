BEGIN;

-- ================================================================
-- Migration 257: patients.is_test — marca de registro sintético
-- ================================================================
-- Contexto: o synthetic monitoring (e2e-prod) vai rodar a jornada REAL do
-- paciente contra produção todo dia às 3h: preenche o form público, agenda a
-- entrevista, confere o big number na tela. Isso CRIA paciente de verdade em
-- produção — e hoje não há como distinguir nem como limpar.
--
-- `workers` e `job_postings` já têm exatamente esta coluna, pelo mesmo motivo
-- (a jornada worker do e2e-prod). Esta migration fecha o buraco em `patients`.
--
-- DECISÕES:
--
--   (a) NÃO filtramos is_test das estatísticas nem do funil, de propósito.
--       O teste diário PRECISA ver o big number subir na tela para provar que
--       o pipeline chegou até lá — e depois cai de novo quando ele limpa. Um
--       filtro escondido tornaria o teste cego justamente no que ele mede.
--       A garantia de não-poluição é o TEARDOWN (purge no fim do run) + o
--       sweeper, não um filtro permanente.
--
--   (b) DEFAULT false + NOT NULL: todo registro existente e todo caminho de
--       escrita atual continuam produzindo dado real sem tocar em nada. Só a
--       rota de admin `PATCH /patients/:id/test-flag` liga a marca.
--
--   (c) Índice PARCIAL (só WHERE is_test) — a coluna é overwhelmingly false;
--       um índice cheio seria desperdício. O sweeper varre por `is_test=true`,
--       que é exatamente o que o índice parcial serve rápido.
-- ================================================================

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN patients.is_test IS
  'Registro sintético criado pelo synthetic monitoring (e2e-prod). Nunca é dado real de paciente. Alvo do teardown/sweeper. NÃO é filtrado das métricas — ver migration 257.';

CREATE INDEX IF NOT EXISTS idx_patients_is_test
  ON patients (created_at DESC)
  WHERE is_test = true;

COMMIT;
