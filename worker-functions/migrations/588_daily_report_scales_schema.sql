-- 588 — Catálogo de escalas do registro diário (spec 092, F1, design §Dados "Migration A").
--
-- O catálogo da 091 (587) traz pergunta/escala/indicador só no JSON normalizado — 0 colunas no banco. Esta migration cria
-- o DONO desses conceitos (catálogo global, SEM PHI): a escala, as opções de resposta (com nota e aviso quando a planilha
-- os define), os motivos de "No lo hizo" e as colunas de pergunta/escala nos objetivos e nas atividades. A carga é a 589
-- (gerada); esta é SÓ schema. O informe em si (PHI) é a migration seguinte (spec 092, F2).
--
-- ── Decisões (design.md da 092) ──────────────────────────────────────────────
--   DC-6   a NOTA é derivada, nunca copiada: a resposta aponta para a opção (scale_code, option_code) e a nota mora só em
--          daily_report_scale_options.score. Opção já referenciada por resposta é IMUTÁVEL (trigger abaixo): nota nova = opção nova.
--          A tabela de respostas ainda não existe aqui; o trigger a consulta por to_regclass (dinâmico) e passa a valer sozinho
--          quando ela nascer. Opção SEM resposta continua corrigível.
--   F-2    `score` é NULL quando a planilha não define nota (lacuna L1); NUNCA inventada. `alert_kind` é NULL quando a planilha
--          não associa aviso à opção.
--   DC-4   `daily_question`/`daily_scale_code` NULL = objetivo fora do catálogo CID (legado/manual): não é perguntado.
--          A regra "atividade sem escala vira Sí/No" mora só no DailyReportTemplate (código), não na coluna.
--   option_code / reason_code = o rótulo da planilha em minúsculas, sem acento, não-alfanumérico -> '_' (números ficam como
--          estão: '1'..'5', '0'). É a chave estável: renomear o texto (label_es) não muda o código; reordenar não muda o sentido.
--
-- Catálogo é escrito só por migration (dono). app_runtime/app_system/enlite_runtime/enlite_system: SELECT apenas.
-- Aditiva e idempotente (IF NOT EXISTS / DROP IF EXISTS). O runner envolve em transação.
-- Rollback (antes do merge): revert do commit. Depois: migration nova que remove as colunas e as 3 tabelas (sem PHI nelas).

-- ── 1. Escalas ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_report_scales (
  code        TEXT PRIMARY KEY
              CONSTRAINT daily_report_scales_code_lista CHECK (code IN (
                'ANI','SUE','GEN','ORI','COM','INI','AUT','FRE','DOL','SN','CNT','OM',
                'C-HIZO','C-SINO','C-ANI','C-DOL','C-CNT','C-ALE')),
  name_es     TEXT NOT NULL CONSTRAINT daily_report_scales_name_len CHECK (length(btrim(name_es)) > 0),
  purpose_es  TEXT NOT NULL CONSTRAINT daily_report_scales_purpose_len CHECK (length(btrim(purpose_es)) > 0),
  answered_by TEXT NOT NULL CONSTRAINT daily_report_scales_answered_by CHECK (answered_by IN ('AT', 'CAREGIVER')),
  answer_kind TEXT NOT NULL CONSTRAINT daily_report_scales_answer_kind CHECK (answer_kind IN ('SINGLE_CHOICE', 'COUNT', 'MULTI_CHOICE'))
);

-- ── 2. Opções de resposta ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_report_scale_options (
  scale_code    TEXT NOT NULL REFERENCES daily_report_scales(code),
  option_code   TEXT NOT NULL CONSTRAINT daily_report_scale_options_code_len CHECK (length(btrim(option_code)) > 0),
  position      SMALLINT NOT NULL CONSTRAINT daily_report_scale_options_position CHECK (position > 0),
  label_es      TEXT NOT NULL CONSTRAINT daily_report_scale_options_label_len CHECK (length(btrim(label_es)) > 0),
  meaning_es    TEXT NOT NULL CONSTRAINT daily_report_scale_options_meaning_len CHECK (length(btrim(meaning_es)) > 0),
  score         SMALLINT NULL,
  alert_kind    TEXT NULL CONSTRAINT daily_report_scale_options_alert_kind CHECK (alert_kind IN ('IMMEDIATE', 'REPEAT', 'CHANGE', 'CONDITIONAL')),
  alert_text_es TEXT NULL,
  asks_reason   BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (scale_code, option_code),
  CONSTRAINT daily_report_scale_options_position_unica UNIQUE (scale_code, position),
  CONSTRAINT daily_report_scale_options_alerta_par CHECK ((alert_kind IS NULL) = (alert_text_es IS NULL))
);

-- ── 3. Motivos de "No lo hizo" ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_report_scale_reasons (
  scale_code  TEXT NOT NULL REFERENCES daily_report_scales(code),
  reason_code TEXT NOT NULL CONSTRAINT daily_report_scale_reasons_code_len CHECK (length(btrim(reason_code)) > 0),
  position    SMALLINT NOT NULL CONSTRAINT daily_report_scale_reasons_position CHECK (position > 0),
  label_es    TEXT NOT NULL CONSTRAINT daily_report_scale_reasons_label_len CHECK (length(btrim(label_es)) > 0),
  PRIMARY KEY (scale_code, reason_code),
  CONSTRAINT daily_report_scale_reasons_position_unica UNIQUE (scale_code, position)
);

COMMENT ON TABLE daily_report_scales IS 'Escalas de resposta do registro diário (planilha do Javier, aba "Escalas de respuesta"). Catálogo global, sem PHI; só migration escreve.';
COMMENT ON TABLE daily_report_scale_options IS 'Opções de cada escala, na ordem da planilha. Opção referenciada por resposta é imutável (nota e código): nota nova = opção nova (DC-6).';
COMMENT ON TABLE daily_report_scale_reasons IS 'Motivos pedidos quando a opção tem asks_reason (AUT: 5; C-HIZO: 3).';
COMMENT ON COLUMN daily_report_scales.answer_kind IS 'SINGLE_CHOICE: botões (com linhas em daily_report_scale_options). COUNT (CNT) e MULTI_CHOICE (OM): sem linhas de opção na V1.';
COMMENT ON COLUMN daily_report_scale_options.option_code IS 'Chave estável da opção: rótulo da planilha em minúsculas, sem acento, não-alfanumérico vira "_"; números ficam como estão.';
COMMENT ON COLUMN daily_report_scale_options.score IS 'NULL = a planilha NÃO define nota para esta opção (lacuna L1); nunca inventada. Preenchida só quando a própria opção é um número na planilha.';
COMMENT ON COLUMN daily_report_scale_options.alert_kind IS 'NULL = a planilha não associa aviso a esta opção. IMMEDIATE: avisa a coordenação na hora; REPEAT: se se repete; CHANGE: se mudou em relação à guarda anterior; CONDITIONAL: só em perguntas de alerta (lacuna L2).';
COMMENT ON COLUMN daily_report_scale_options.alert_text_es IS 'Texto literal da coluna "Qué hace la app" da planilha. NULL exatamente quando alert_kind é NULL.';
COMMENT ON COLUMN daily_report_scale_options.asks_reason IS 'true = a planilha diz "Pide el motivo": o app abre os motivos da escala.';

-- ── 4. Pergunta, escala e indicador nos objetivos; escala nas atividades ─────
ALTER TABLE therapeutic_specific_objectives ADD COLUMN IF NOT EXISTS daily_question TEXT NULL;
ALTER TABLE therapeutic_specific_objectives ADD COLUMN IF NOT EXISTS daily_scale_code TEXT NULL REFERENCES daily_report_scales(code);
ALTER TABLE therapeutic_specific_objectives ADD COLUMN IF NOT EXISTS operative_indicator TEXT NULL;
ALTER TABLE therapeutic_activities ADD COLUMN IF NOT EXISTS daily_scale_code TEXT NULL REFERENCES daily_report_scales(code);

ALTER TABLE therapeutic_specific_objectives DROP CONSTRAINT IF EXISTS therapeutic_specific_objectives_daily_question_scale_par;
ALTER TABLE therapeutic_specific_objectives ADD CONSTRAINT therapeutic_specific_objectives_daily_question_scale_par
  CHECK ((daily_question IS NULL) = (daily_scale_code IS NULL));
ALTER TABLE therapeutic_specific_objectives DROP CONSTRAINT IF EXISTS therapeutic_specific_objectives_daily_question_len;
ALTER TABLE therapeutic_specific_objectives ADD CONSTRAINT therapeutic_specific_objectives_daily_question_len
  CHECK (daily_question IS NULL OR length(btrim(daily_question)) > 0);

COMMENT ON COLUMN therapeutic_specific_objectives.daily_question IS 'Pergunta do registro diário (planilha, coluna "Pregunta del registro diario (EnLite)"). NULL = objetivo fora do catálogo CID (legado/manual): não é perguntado (DC-4 da 092).';
COMMENT ON COLUMN therapeutic_specific_objectives.daily_scale_code IS 'Escala da pergunta (daily_report_scales.code). NULL exatamente quando daily_question é NULL: objetivo fora do catálogo CID, não é perguntado.';
COMMENT ON COLUMN therapeutic_specific_objectives.operative_indicator IS 'Indicador operativo (planilha, "Indicador operativo (EnLite)"), texto livre do Javier. NULL = objetivo fora do catálogo CID. Não é nota: % e contagem saem da opção.';
COMMENT ON COLUMN therapeutic_activities.daily_scale_code IS 'Escala da atividade (daily_report_scales.code). NULL = atividade fora do catálogo CID (legado/manual); a regra "vira Sí/No" mora só no DailyReportTemplate (DC-4), não nesta coluna.';

-- ── 5. Opção referenciada por resposta é imutável (DC-6) ─────────────────────
CREATE OR REPLACE FUNCTION fn_092_scale_option_imutavel_se_referenciada()
RETURNS TRIGGER AS $$
DECLARE
  referenciada BOOLEAN := false;
BEGIN
  IF to_regclass('public.daily_report_answers') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.daily_report_answers WHERE scale_code = $1 AND option_code = $2)'
      INTO referenciada USING OLD.scale_code, OLD.option_code;
  END IF;
  IF referenciada THEN
    RAISE EXCEPTION 'daily_report_option_imutavel: opção %/% já tem resposta; nota nova = opção nova (DC-6)', OLD.scale_code, OLD.option_code
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_092_scale_option_imutavel ON daily_report_scale_options;
CREATE TRIGGER trg_092_scale_option_imutavel
  BEFORE UPDATE ON daily_report_scale_options
  FOR EACH ROW
  WHEN (OLD.score IS DISTINCT FROM NEW.score
     OR OLD.option_code IS DISTINCT FROM NEW.option_code
     OR OLD.scale_code IS DISTINCT FROM NEW.scale_code)
  EXECUTE FUNCTION fn_092_scale_option_imutavel_se_referenciada();

-- ── 6. Privilégios: catálogo só-leitura para os roles do app ─────────────────
DO $$
DECLARE
  r TEXT;
  t TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_runtime', 'app_system', 'enlite_runtime', 'enlite_system'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['daily_report_scales', 'daily_report_scale_options', 'daily_report_scale_reasons'] LOOP
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %I', t, r);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
