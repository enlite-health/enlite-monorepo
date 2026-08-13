-- ================================================================
-- 267 — Trilha de auditoria de patient_chat_ids (quem vinculou o quê, quando)
-- ================================================================
-- Por quê (pedido do Gabriel, 13/08, task 86ak04ygu): os logs estruturados do
-- espelho ClickUp→Postgres respondem "está acontecendo AGORA?", mas o bucket
-- _Default do Cloud Logging retém 30 DIAS — e a tabela viva só guarda o estado
-- atual (um chat_id sobrescrito perde o valor antigo sem rastro). Para
-- rastreabilidade FUTURA a trilha precisa ser dado, não log.
--
-- Padrão D95 (mesma mecânica das migrations 079/096/169): trigger na própria
-- tabela lendo `app.current_uid` — pega TODOS os escritores no ponto único
-- (sync do ClickUp, drawer da tela, psql à mão), na MESMA transação da escrita.
-- Ator com fonte no PREFIXO: `sync:clickup-patients`, `staff:<uid>`, etc.
-- Sem ator setado → changed_by NULL, e a LEITURA deriva 'nao_instrumentado'
-- (proibido inferir — convenção D95). NULLIF por causa de um quirk real do
-- Postgres: após um SET LOCAL numa conexão de pool, a GUC custom volta como
-- STRING VAZIA (não NULL) para a sessão — sem o NULLIF, escrita à mão numa
-- conexão reusada carimbaria '' como autor (visto no e2e A4).
--
-- Nota de representação: a REESCRITA de um papel pelo caminho de produção
-- aparece como UNLINK+LINK no mesmo instante/ator (o applyChatIds solta a
-- linha antiga antes de inserir — é o que torna o swap atômico). O op CHANGE
-- fica como defesa para UPDATE direto via SQL.
--
-- ⚠️ SÓ IDENTIFICADORES, por construção (mesma regra do chat-map): patient_id,
-- papel e JIDs de grupo. Nome/telefone/documento NUNCA entram aqui.
--
-- SEM foreign key para patients DE PROPÓSITO: trilha é razão social do dado —
-- precisa sobreviver ao registro que audita (um FK com CASCADE apagaria a
-- história junto; pacientes são soft-delete, mas a trilha não deve depender
-- disso). Órfão aqui não é bug, é história.

BEGIN;

CREATE TABLE IF NOT EXISTS patient_chat_id_changes (
  id           BIGSERIAL PRIMARY KEY,
  patient_id   UUID        NOT NULL,
  role         VARCHAR(32) NOT NULL,
  -- INSERT: old NULL → new preenchido · UPDATE: ambos · DELETE: old → new NULL
  old_chat_id  VARCHAR(64),
  new_chat_id  VARCHAR(64),
  op           VARCHAR(6)  NOT NULL CHECK (op IN ('LINK', 'CHANGE', 'UNLINK')),
  changed_by   TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE patient_chat_id_changes IS
  'Trilha append-only dos vínculos de grupo de WhatsApp do paciente (migration 267). changed_by NULL = nao_instrumentado na leitura, nunca inferir.';

CREATE INDEX IF NOT EXISTS idx_patient_chat_id_changes_patient
  ON patient_chat_id_changes (patient_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_chat_id_changes_at
  ON patient_chat_id_changes (changed_at DESC);

CREATE OR REPLACE FUNCTION fn_log_patient_chat_id_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO patient_chat_id_changes (patient_id, role, old_chat_id, new_chat_id, op, changed_by)
    VALUES (NEW.patient_id, NEW.role, NULL, NEW.chat_id, 'LINK',
            NULLIF(current_setting('app.current_uid', true), ''));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.chat_id IS DISTINCT FROM NEW.chat_id THEN
      INSERT INTO patient_chat_id_changes (patient_id, role, old_chat_id, new_chat_id, op, changed_by)
      VALUES (NEW.patient_id, NEW.role, OLD.chat_id, NEW.chat_id, 'CHANGE',
              NULLIF(current_setting('app.current_uid', true), ''));
    END IF;
    RETURN NEW;
  ELSE -- DELETE (desvínculo explícito, move, ou trigger de soft-delete da 263)
    INSERT INTO patient_chat_id_changes (patient_id, role, old_chat_id, new_chat_id, op, changed_by)
    VALUES (OLD.patient_id, OLD.role, OLD.chat_id, NULL, 'UNLINK',
            NULLIF(current_setting('app.current_uid', true), ''));
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_chat_id_changes ON patient_chat_ids;
CREATE TRIGGER trg_patient_chat_id_changes
  AFTER INSERT OR UPDATE OR DELETE ON patient_chat_ids
  FOR EACH ROW EXECUTE FUNCTION fn_log_patient_chat_id_change();

-- Baseline: os 242 vínculos do backfill de 13/08 já existem SEM linha na trilha
-- (a trigger nasce agora). Semeia o estado atual como LINK para a trilha contar
-- a história completa desde o primeiro dia — carimbado como migration, não como
-- pessoa, porque foi esta migration que os registrou.
INSERT INTO patient_chat_id_changes (patient_id, role, old_chat_id, new_chat_id, op, changed_by, changed_at)
SELECT c.patient_id, c.role, NULL, c.chat_id, 'LINK', 'system:migration-267-baseline', c.created_at
  FROM patient_chat_ids c;

COMMIT;
