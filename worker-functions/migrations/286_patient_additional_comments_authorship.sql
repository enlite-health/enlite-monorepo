-- Migration 286: autoria da última edição das "observações gerais" do paciente (REQ-01 · D195)
--
-- `additional_comments` vira área de texto longa editável no painel; a ficha passa a mostrar
-- QUEM editou por último e QUANDO. Só o uid do staff é gravado (pseudonimização — o nome é
-- resolvido na leitura em `users`); o texto NUNCA vai para trilha/log (lex 29/08, item 3).
-- Aditiva: duas colunas nullable. Sem versionamento (D195: "sem infraestrutura por ora").
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS additional_comments_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS additional_comments_updated_by VARCHAR(128);

COMMENT ON COLUMN patients.additional_comments_updated_at IS
  'Quando additional_comments foi editado pela última vez pelo painel (NULL = nunca editado por lá).';
COMMENT ON COLUMN patients.additional_comments_updated_by IS
  'firebase_uid do staff que fez a última edição de additional_comments. Nome resolvido na leitura (users). Nunca o valor.';
