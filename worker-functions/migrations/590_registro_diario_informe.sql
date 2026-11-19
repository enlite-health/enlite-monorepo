-- 590 — Informe da guarda (registro diário do prestador) — spec 092, F2, design §Dados "Migration C" (DADO CLÍNICO / PHI).
--
-- Cria o DONO do conceito "informe da guarda": uma linha por guarda (prestador × faixa do itinerário × dia), as respostas por item
-- (objetivo ou atividade) e o relatório descritivo. O catálogo de escalas é da 588/589 (sem PHI); aqui só nasce o que carrega paciente.
--
-- ── Decisões (design.md da 092) ──────────────────────────────────────────────
--   DC-6   a NOTA é derivada, nunca copiada: a resposta guarda (scale_code, option_code); a nota é daily_report_scale_options.score,
--          lida por join (view daily_report_answer_scores). Com esta tabela criada, o trigger da 588 (opção referenciada é imutável,
--          que a consulta por to_regclass) PASSA A BLOQUEAR de verdade.
--   DC-7   informe IMUTÁVEL depois de recebido: UPDATE é sempre recusado (55000). DELETE só quando o PAI some (o purge do paciente entra por
--          CASCADE de patient_contracted_services -> patient_itinerary_slot, molde 416/lex C5); DELETE direto, nunca.
--          ⚑ Divergência consciente do desenho: as respostas apontam ao informe com ON DELETE CASCADE (não RESTRICT), e o informe ao slot e à
--          versão do PTI também com ON DELETE CASCADE. Com RESTRICT/NO ACTION o purge do paciente ficaria IMPOSSÍVEL assim que existisse 1
--          informe (lex C4: o dado clínico morre com o paciente; achado pelo e2e: o PTI sai antes do informe na cascata). A imutabilidade
--          segue inteira: o trigger recusa UPDATE e DELETE direto; DELETE só com a cadeia informe → faixa → serviço → paciente QUEBRADA.
--   DC-1   narrative: 1..8000 caracteres após btrim. É TEXTO CLÍNICO LIVRE: nunca em log, erro, métrica ou GBrain.
--   F-5    a ocorrência é virtual (uuid v5 de slot|data|worker): NÃO é coluna. Paciente também não é coluna: deriva de
--          slot -> patient_contracted_services -> patient_id (D514/D516, um dono, derivado nunca gravado).
--   DC-2   prazo e atraso são derivados (device_submitted_at > fim da guarda + 24 h); nada gravado.
--   scale_code da resposta é FATO CONGELADO (a escala que foi perguntada): a FK composta precisa dele e a escala do item pode mudar
--          numa carga futura. Não é cópia de dado: ninguém o lê para outro fim.
--
-- RLS: segue o slot (molde 480): a policy não olha país da própria linha, olha a visibilidade do slot, que já segue o serviço e o paciente.
-- Privilégios: app_runtime/app_system/enlite_runtime/enlite_system SELECT+INSERT (sem UPDATE/DELETE/TRUNCATE). enlite_mcp_ro: REVOGADO (clínico).
-- Aditiva e idempotente (IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE). O runner envolve em transação.
-- Rollback (antes do merge): revert do commit. Depois: migration nova que remove as 2 views e as 2 tabelas (perde os informes).

-- ── 1. Informe ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_reports (
  id                  UUID        PRIMARY KEY,   -- gerado no app (uuid v7): a chave de idempotência do PUT
  worker_id           UUID        NOT NULL REFERENCES workers(id),
  slot_id             UUID        NOT NULL REFERENCES patient_itinerary_slot(id) ON DELETE CASCADE,
  on_date             DATE        NOT NULL,
  pti_version_id      UUID        NULL REFERENCES patient_therapeutic_projects(id) ON DELETE CASCADE,
  narrative           TEXT        NOT NULL,
  narrative_source    TEXT        NOT NULL,
  device_submitted_at TIMESTAMPTZ NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_version         TEXT        NOT NULL,
  CONSTRAINT daily_reports_narrative_len CHECK (char_length(btrim(narrative)) BETWEEN 1 AND 8000),
  CONSTRAINT daily_reports_narrative_source CHECK (narrative_source IN ('TYPED', 'DICTATED', 'MIXED')),
  CONSTRAINT daily_reports_app_version_len CHECK (char_length(btrim(app_version)) BETWEEN 1 AND 64),
  CONSTRAINT daily_reports_guarda_unica UNIQUE (worker_id, slot_id, on_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_reports_slot_date ON daily_reports (slot_id, on_date);

-- ── 2. Respostas por item ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_report_answers (
  report_id    UUID     NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
  objective_id UUID     NULL REFERENCES therapeutic_specific_objectives(id),
  activity_id  UUID     NULL REFERENCES therapeutic_activities(id),
  scale_code   TEXT     NOT NULL REFERENCES daily_report_scales(code),
  option_code  TEXT     NULL,
  count_value  INTEGER  NULL,
  reason_code  TEXT     NULL,
  CONSTRAINT daily_report_answers_item_um CHECK ((objective_id IS NULL) <> (activity_id IS NULL)),
  CONSTRAINT daily_report_answers_valor_um CHECK ((option_code IS NULL) <> (count_value IS NULL)),
  CONSTRAINT daily_report_answers_count_faixa CHECK (count_value IS NULL OR count_value BETWEEN 0 AND 999),
  CONSTRAINT daily_report_answers_motivo_so_com_opcao CHECK (reason_code IS NULL OR option_code IS NOT NULL),
  CONSTRAINT daily_report_answers_opcao_fk FOREIGN KEY (scale_code, option_code)
    REFERENCES daily_report_scale_options (scale_code, option_code),
  CONSTRAINT daily_report_answers_motivo_fk FOREIGN KEY (scale_code, reason_code)
    REFERENCES daily_report_scale_reasons (scale_code, reason_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_report_answers_objective ON daily_report_answers (report_id, objective_id) WHERE objective_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_report_answers_activity ON daily_report_answers (report_id, activity_id) WHERE activity_id IS NOT NULL;
-- Lookup da trava de opção referenciada (588) e dos sinais por opção.
CREATE INDEX IF NOT EXISTS idx_daily_report_answers_option ON daily_report_answers (scale_code, option_code);

-- ── 3. Motivo só com a opção que o pede (asks_reason) ────────────────────────
CREATE OR REPLACE FUNCTION fn_092_answer_motivo_coerente()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reason_code IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM daily_report_scale_options o
     WHERE o.scale_code = NEW.scale_code AND o.option_code = NEW.option_code AND o.asks_reason
  ) THEN
    RAISE EXCEPTION 'daily_report_motivo_nao_pedido: a opção não pede motivo (asks_reason = false)'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_092_answer_motivo ON daily_report_answers;
CREATE TRIGGER trg_092_answer_motivo
  BEFORE INSERT ON daily_report_answers
  FOR EACH ROW EXECUTE FUNCTION fn_092_answer_motivo_coerente();

-- ── 4. Imutabilidade (DC-7) ──────────────────────────────────────────────────
-- Mensagens de exceção NUNCA citam narrative nem respostas (texto clínico): só o código da regra.
CREATE OR REPLACE FUNCTION fn_092_daily_report_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'daily_report_imutavel: informe recebido não se edita (DC-7)' USING ERRCODE = '55000';
  END IF;
  -- DELETE: só quando a cadeia faixa → serviço → paciente já está QUEBRADA (o que o CASCADE do purge faz, em qualquer ordem entre
  -- faixa, serviço e versão do PTI); direto, nunca.
  IF EXISTS (
    SELECT 1 FROM patient_itinerary_slot s
      JOIN patient_contracted_services c ON c.id = s.contracted_service_id
      JOIN patients p ON p.id = c.patient_id
     WHERE s.id = OLD.slot_id
  ) THEN
    RAISE EXCEPTION 'daily_report_imutavel: informe recebido não se apaga (DC-7)' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_092_daily_report_imutavel ON daily_reports;
CREATE TRIGGER trg_092_daily_report_imutavel
  BEFORE UPDATE OR DELETE ON daily_reports
  FOR EACH ROW EXECUTE FUNCTION fn_092_daily_report_imutavel();

CREATE OR REPLACE FUNCTION fn_092_daily_report_answer_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'daily_report_imutavel: resposta de informe recebido não se edita (DC-7)' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM daily_reports r WHERE r.id = OLD.report_id) THEN
    RAISE EXCEPTION 'daily_report_imutavel: resposta de informe recebido não se apaga (DC-7)' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_092_daily_report_answer_imutavel ON daily_report_answers;
CREATE TRIGGER trg_092_daily_report_answer_imutavel
  BEFORE UPDATE OR DELETE ON daily_report_answers
  FOR EACH ROW EXECUTE FUNCTION fn_092_daily_report_answer_imutavel();

-- ── 5. RLS: segue o pai (molde 480) ──────────────────────────────────────────
ALTER TABLE daily_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS daily_reports_follow_slot ON daily_reports;
CREATE POLICY daily_reports_follow_slot ON daily_reports FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_itinerary_slot s WHERE s.id = daily_reports.slot_id)
);

ALTER TABLE daily_report_answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS daily_report_answers_follow_report ON daily_report_answers;
CREATE POLICY daily_report_answers_follow_report ON daily_report_answers FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM daily_reports r WHERE r.id = daily_report_answers.report_id)
);

-- ── 6. Views (derivados, nunca coluna) ───────────────────────────────────────
-- security_invoker: a view lê COMO QUEM CONSULTA, então a RLS das tabelas vale (sem isso a view roda como dono e a ignora, migration 455).
CREATE OR REPLACE VIEW daily_report_answer_scores WITH (security_invoker = true) AS
  SELECT a.report_id, a.objective_id, a.activity_id, a.scale_code, a.option_code, a.count_value, a.reason_code, o.score
    FROM daily_report_answers a
    LEFT JOIN daily_report_scale_options o ON o.scale_code = a.scale_code AND o.option_code = a.option_code;

CREATE OR REPLACE VIEW daily_report_alert_signals WITH (security_invoker = true) AS
  SELECT a.report_id, a.objective_id, a.activity_id, a.scale_code, a.option_code, o.alert_text_es
    FROM daily_report_answers a
    JOIN daily_report_scale_options o ON o.scale_code = a.scale_code AND o.option_code = a.option_code
   WHERE o.alert_kind = 'IMMEDIATE';

-- ── 7. COMMENTs (o que NULL e cada coluna significam) ────────────────────────
COMMENT ON TABLE daily_reports IS
  'Informe da guarda enviado pelo prestador depois do check-out (spec 092). Uma linha por (worker, slot, on_date); IMUTÁVEL (DC-7). '
  'DADO CLÍNICO IDENTIFICÁVEL: narrative é texto livre sobre o paciente, NUNCA em log, erro, métrica, prompt ou GBrain. '
  'Satélite do itinerário: RLS segue o slot; o purge do paciente entra por CASCADE. REVOGADA do enlite_mcp_ro.';
COMMENT ON COLUMN daily_reports.id IS 'uuid v7 gerado no app: chave de idempotência do PUT (mesmo id + mesmo corpo = 200).';
COMMENT ON COLUMN daily_reports.pti_version_id IS 'NULL = não havia PTI vigente para o serviço da guarda na data (DC-4): informe só com narrativa. Contável pela coordenação.';
COMMENT ON COLUMN daily_reports.narrative IS 'Relatório descritivo (texto clínico livre, 1..8000 após trim). NUNCA em log/erro. Sai só com daily_report_narrative:read.';
COMMENT ON COLUMN daily_reports.narrative_source IS 'TYPED, DICTATED (transcrição on-device) ou MIXED. O áudio nunca sobe.';
COMMENT ON COLUMN daily_reports.device_submitted_at IS 'Instante do envio no aparelho. O atraso é DERIVADO (device_submitted_at > fim da guarda + 24 h, DC-2), nunca gravado.';
COMMENT ON COLUMN daily_reports.received_at IS 'Instante em que o servidor aceitou o informe.';
COMMENT ON TABLE daily_report_answers IS
  'Resposta por item do informe (objetivo OU atividade). A nota NÃO está aqui: deriva de daily_report_scale_options.score (view daily_report_answer_scores, DC-6). '
  'Atividade sem linha = "não registrada" (único significado, DC-8). Dado clínico: REVOGADA do enlite_mcp_ro.';
COMMENT ON COLUMN daily_report_answers.scale_code IS 'Escala que foi PERGUNTADA (fato congelado; a FK composta precisa dele). Não é cópia: nada o lê para outro fim.';
COMMENT ON COLUMN daily_report_answers.option_code IS 'Opção escolhida (escalas de botões). NULL exatamente quando count_value não é NULL.';
COMMENT ON COLUMN daily_report_answers.count_value IS 'Valor da escala de contagem (CNT), 0..999. NULL exatamente quando option_code não é NULL. Valor, não nota.';
COMMENT ON COLUMN daily_report_answers.reason_code IS 'Motivo de "No lo hizo" (só quando a opção tem asks_reason). NULL = sem motivo.';
COMMENT ON VIEW daily_report_answer_scores IS 'Resposta + nota por join (DC-6). score NULL = a planilha não define nota para a opção (L1) ou a escala é de contagem.';
COMMENT ON VIEW daily_report_alert_signals IS 'Respostas cuja opção tem aviso IMEDIATO na planilha (DC-5): sinal derivado para o painel; nenhum envio automático.';

-- ── 8. Privilégios ───────────────────────────────────────────────────────────
-- Os default privileges da 269 concedem SELECT/INSERT/UPDATE/DELETE: aqui se tira UPDATE/DELETE/TRUNCATE (imutável, DC-7).
DO $$
DECLARE
  r TEXT;
  t TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['app_runtime', 'app_system', 'enlite_runtime', 'enlite_system'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      FOREACH t IN ARRAY ARRAY['daily_reports', 'daily_report_answers'] LOOP
        EXECUTE format('GRANT SELECT, INSERT ON %I TO %I', t, r);
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %I', t, r);
      END LOOP;
      EXECUTE format('GRANT SELECT ON daily_report_answer_scores, daily_report_alert_signals TO %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enlite_mcp_ro') THEN
    EXECUTE 'REVOKE ALL ON daily_reports, daily_report_answers, daily_report_answer_scores, daily_report_alert_signals FROM enlite_mcp_ro';
  END IF;
END
$$;
