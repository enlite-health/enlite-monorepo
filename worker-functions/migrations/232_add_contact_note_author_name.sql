-- 232_add_contact_note_author_name.sql
--
-- Adiciona snapshot do NOME do operador autor da nota de contato.
-- Aditiva: coluna nullable. Notas antigas ficam com NULL (UI faz fallback pro email).
-- O nome é resolvido de users.display_name no momento do insert (ver CreateContactNoteUseCase),
-- denormalizado como snapshot — igual ao que já é feito com created_by_admin_email.

ALTER TABLE wja_contact_notes
  ADD COLUMN IF NOT EXISTS created_by_admin_name TEXT;
