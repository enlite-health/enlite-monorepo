BEGIN;

CREATE TABLE IF NOT EXISTS conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  root_message_id uuid NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  author_uid varchar(128) NOT NULL,
  body_encrypted text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz NULL,
  deleted_at timestamptz NULL
);

COMMENT ON COLUMN conversation_messages.body_encrypted IS
  'Cifrado via KMSEncryptionService (mesmo padrão de PatientRepository.ts) — NUNCA em claro, NUNCA '
  'em log/prompt/GBrain/payload de notificação. NULL após soft delete (deleted_at preenchido).';
COMMENT ON COLUMN conversation_messages.root_message_id IS
  'NULL = mensagem de topo. Thread de 1 nível: o servidor normaliza reply-de-reply para o ROOT do '
  'root antes de gravar (nunca aponta para outra reply) — ver PostMessageUseCase.';

CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread
  ON conversation_messages (conversation_id, root_message_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_message_mentions (
  message_id uuid NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  mentioned_uid varchar(128) NOT NULL,
  PRIMARY KEY (message_id, mentioned_uid)
);

CREATE TABLE IF NOT EXISTS conversation_read_marks (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_uid varchar(128) NOT NULL,
  last_read_at timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, user_uid)
);

CREATE OR REPLACE FUNCTION conversation_messages_enforce_one_level() RETURNS trigger AS $$
DECLARE
  root_of_root uuid;
BEGIN
  IF NEW.root_message_id IS NOT NULL THEN
    SELECT root_message_id INTO root_of_root FROM conversation_messages WHERE id = NEW.root_message_id;
    IF root_of_root IS NOT NULL THEN
      RAISE EXCEPTION '[conversation] root_message_id % já é uma reply (root %); thread é de 1 nível',
        NEW.root_message_id, root_of_root;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversation_messages_one_level ON conversation_messages;
CREATE TRIGGER trg_conversation_messages_one_level
  BEFORE INSERT OR UPDATE OF root_message_id ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION conversation_messages_enforce_one_level();

GRANT SELECT, INSERT, UPDATE ON conversation_messages TO app_runtime, app_system;
GRANT SELECT, INSERT ON conversation_message_mentions TO app_runtime, app_system;
GRANT SELECT, INSERT, UPDATE ON conversation_read_marks TO app_runtime, app_system;

-- RLS: conversation_messages não tem FK direta para `patients` (só para `conversations`), então o
-- invariante do country-rls-policies.test.ts não a pega — mas é literalmente o CORPO da conversa
-- sobre o paciente, então segue o mesmo molde "follow the parent" (413/426), delegando a decisão de
-- país para a RLS de `conversations` (que por sua vez segue `patients`, policy da 411). Sem essa
-- policy, `SELECT * FROM conversation_messages` direto (sem JOIN) vazaria metadado de conversa de
-- outro país para app_runtime.
ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_messages_follow_patient ON conversation_messages;
CREATE POLICY conversation_messages_follow_patient ON conversation_messages FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_messages.conversation_id)
);

-- RLS: `conversation_message_mentions` e `conversation_read_marks` também não têm FK direta para
-- `patients` (mentions → messages, read_marks → conversations) — fecho da classe apontada em
-- `achados.md` (gate revisao-pr, Bloco 1): eram as ÚNICAS satélites do módulo sem RLS além de
-- `notifications` (460). Mesmo molde "follow the immediate parent" já usado acima em
-- `conversation_messages_follow_patient` — o EXISTS aponta para a tabela-PAI imediata (não para
-- `patients` direto), e a visibilidade do país é decidida pela RLS DESSA tabela-pai (que por sua vez
-- já segue `conversations`/`patients`). Sem isso, `SELECT * FROM conversation_message_mentions`
-- direto (sem JOIN) vazaria METADADO cross-país: quem mencionou quem, quem leu o quê e quando.
ALTER TABLE conversation_message_mentions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_message_mentions_follow_patient ON conversation_message_mentions;
CREATE POLICY conversation_message_mentions_follow_patient ON conversation_message_mentions FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM conversation_messages m WHERE m.id = conversation_message_mentions.message_id)
);

ALTER TABLE conversation_read_marks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_read_marks_follow_patient ON conversation_read_marks;
CREATE POLICY conversation_read_marks_follow_patient ON conversation_read_marks FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_read_marks.conversation_id)
);

COMMIT;
