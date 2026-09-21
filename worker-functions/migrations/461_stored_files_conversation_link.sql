BEGIN;

-- Vínculo de posse (spec 022, Bloco 3): `stored_files` (migration 459) nasceu SEM ligação a
-- paciente/conversa — achado do gate revisao-pr do B1 (evidencias/achados.md): um staff com
-- `patient_conversation:create` podia anexar (POST messages, `fileIds`) o uuid de um arquivo
-- de OUTRO paciente, contanto que soubesse o id (não enumerável pela API, mas sem cruzamento
-- nenhum). `conversation_id` fecha isso: todo arquivo pertence a UMA conversa (= paciente, D-07),
-- preenchido no upload (T312, único gravador de `stored_files` desde sempre — NOT NULL seguro,
-- sem linha legada).
-- `IF NOT EXISTS` (achado do gate revisao-pr, B3): sem ele, era a ÚNICA `ADD COLUMN` sem essa
-- guarda em `migrations/4[0-6]*.sql` — não re-rodável. Com `IF NOT EXISTS`, a 2ª execução PULA a
-- cláusula inteira (inclusive `NOT NULL`/`REFERENCES`) quando a coluna já existe — Postgres não
-- tenta reaplicar NOT NULL numa coluna que já é NOT NULL, então não há linha legada a violar.
ALTER TABLE stored_files
  ADD COLUMN IF NOT EXISTS conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE;

COMMENT ON COLUMN stored_files.conversation_id IS
  'Vínculo de posse (spec 022, Bloco 3, D-14): preenchido pela rota de upload a partir do :id da '
  'rota (paciente). PostMessageUseCase.assertFilesOwnedByAuthor cruza este valor com o '
  'conversationId da mensagem antes de aceitar um fileId no body — sem isso, um arquivo de outro '
  'paciente era um anexo válido para quem soubesse o uuid.';

CREATE INDEX IF NOT EXISTS idx_stored_files_conversation ON stored_files (conversation_id);

-- RLS: `stored_files` não tem FK direta para `patients` (só para `conversations`, que já segue
-- `patients` — migration 457) — mesmo molde "follow the immediate parent" de
-- `conversation_messages_follow_patient` (migration 458). Sem esta policy, `SELECT * FROM
-- stored_files` direto (sem JOIN) vazaria METADADO (bucket/content_type/tamanho — nome do
-- arquivo já vem cifrado, mas o metadado sozinho ainda identifica atividade) cross-país para
-- `app_runtime`.
ALTER TABLE stored_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stored_files_follow_conversation ON stored_files;
CREATE POLICY stored_files_follow_conversation ON stored_files FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = stored_files.conversation_id)
);

-- `conversation_message_attachments` (migration 459) também nasceu sem RLS — mesma classe de
-- achado. Sem FK direta para `patients` (message_id → conversation_messages, file_id →
-- stored_files); segue `conversation_messages`, que por sua vez já segue `conversations` →
-- `patients`. Sem isso, `SELECT * FROM conversation_message_attachments` vazaria METADADO de
-- qual arquivo está em qual mensagem, cross-país.
ALTER TABLE conversation_message_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_message_attachments_follow_message ON conversation_message_attachments;
CREATE POLICY conversation_message_attachments_follow_message ON conversation_message_attachments FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM conversation_messages m WHERE m.id = conversation_message_attachments.message_id)
);

-- Achado do gate revisao-pr (B3): a PK é `(message_id, file_id)` — não impede o MESMO `file_id`
-- de ser anexado a 2 mensagens diferentes (mesmo autor/conversa). `PostMessageUseCase.assertFilesOwnedByAuthor`
-- já recusa isso por SELECT (`NOT EXISTS conversation_message_attachments`), mas SEM LOCK: 2 POSTs
-- concorrentes que leem o SELECT antes de qualquer um inserir passam os dois. Um arquivo, uma
-- mensagem — UNIQUE índice fecha a corrida no banco; `PostMessageUseCase.attachFiles` traduz a
-- violação (`23505`) para o MESMO 400 (`AttachedFileNotFoundError`) que a checagem de posse já usa.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_message_attachments_file_id_unique
  ON conversation_message_attachments (file_id);

COMMIT;
