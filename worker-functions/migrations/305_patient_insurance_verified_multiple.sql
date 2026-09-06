-- 305 — `Cobertura Verificada` múltipla (Fase 3 da change `campos-admissao`, D-D)
--
-- ── O QUE ESTA MIGRATION CONSERTA ───────────────────────────────────────────
-- `patients.insurance_verified` é `TEXT` escalar desde a 037. O campo VIVO no ClickUp é
-- `labels` com **33 opções** — múltiplo por natureza — e **345 de 349** pacientes o têm
-- preenchido lá. Do nosso lado: **ZERO** (F5/F7), porque o mapper nunca leu o campo.
-- É a maior lacuna medida da change.
--
-- ⚠️ Cardinalidade MEDIDA na véspera, não suposta (F34, reconferido em 24/08 com
-- `bin/medir-multiplicidade-clickup.py`, autoteste 106/106, cobertura 349/349):
--     4 vazios · 344 com 1 valor · 1 com 2 valores · zero com 3+
-- ⇒ múltiplo custa **1 paciente** hoje. Mas o campo é `labels`: o custo de HOJE não é o
-- desenho. Modelar escalar porque "quase ninguém tem 2" é como o segmento clínico chegou
-- na Fase 2 — colapsando o que a origem distinguia.
--
-- ── POR QUE TABELA E NÃO ARRAY ──────────────────────────────────────────────
-- Mesmo desenho da 304, e pelo mesmo motivo: array não tem ORDINAL estável nem constraint
-- por item. Aqui não há teto de 3 (o de segmento veio do D-C); o teto é o CATÁLOGO, que tem
-- 33 opções — e ele é conferido no código, não aqui, porque catálogo muda sem migration.
--
-- ── O QUE NÃO É TOCADO, DE PROPÓSITO ────────────────────────────────────────
-- `patients.insurance_verified` (escalar) CONTINUA existindo e sendo escrita, exatamente
-- como o derivado da D-B na Fase 2: o novo nasce AO LADO, nunca no lugar. Quem lê hoje
-- (`VacanciesController`, `PatientDetailQueryHelper`, `PatientIdentityRepository`) não
-- quebra. `health_insurance_name` e `insurance_informed` ficam **deprecadas sem DROP** —
-- a fase marca, não remove.
--
-- Rollback: `DROP TABLE patient_insurance_verified;` — a tabela nasce vazia e o backfill
-- que a preenche marca `source`, então desfazer é exato. Nada preexistente se perde.

CREATE TABLE IF NOT EXISTS patient_insurance_verified (
  patient_id   UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  ordinal      SMALLINT    NOT NULL,
  raw_label    TEXT        NOT NULL,
  source       TEXT        NOT NULL DEFAULT 'clickup',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT patient_insurance_verified_pkey
    PRIMARY KEY (patient_id, ordinal),

  -- Sem teto de 3 aqui: o limite é o catálogo (33), e catálogo muda sem migration. O que
  -- se garante no banco é que a POSIÇÃO é positiva e que não há buraco silencioso no 0.
  CONSTRAINT patient_insurance_verified_ordinal_positive
    CHECK (ordinal >= 1),

  -- Cobertura em branco não é cobertura: seria "sem obra social" travestido de dado.
  -- `btrim` não remove NBSP, e é assim que tem de ser — o rótulo é gravado LITERAL.
  CONSTRAINT patient_insurance_verified_raw_label_not_blank
    CHECK (btrim(raw_label) <> '')
);

-- A MESMA cobertura duas vezes no mesmo paciente é erro da origem, não dado. Sem isto,
-- reordenar opções no ClickUp geraria duplicata em vez de recusa (a lição da 304).
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_insurance_verified_value
  ON patient_insurance_verified (patient_id, raw_label);

-- Quem pergunta "quais pacientes têm a cobertura X?" — é a consulta do painel e do backfill.
CREATE INDEX IF NOT EXISTS idx_patient_insurance_verified_label
  ON patient_insurance_verified (raw_label);

COMMENT ON TABLE patient_insurance_verified IS
  'Cobertura Verificada do ClickUp, MÚLTIPLA e literal (Fase 3 de campos-admissao, D-D). '
  'Nasce ao lado de patients.insurance_verified (escalar), nunca no lugar dele. '
  'Satélite de `patients` para o ABAC F1: jurisdição derivada da FK obrigatória, sem coluna '
  '`country` própria (mesma cláusula que cobre patient_source_labels — C-A do parecer lex de 24/08). '
  'Retenção: enquanto a tarefa existir no ClickUp; supressão junto do soft delete do paciente.';

COMMENT ON COLUMN patient_insurance_verified.raw_label IS
  'Rótulo LITERAL da opção no ClickUp, como veio da origem (inclusive NBSP no fim, se houver). '
  'Não é enum: o catálogo vivo tem 33 opções e muda sem migration.';
