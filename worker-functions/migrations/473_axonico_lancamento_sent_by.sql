-- 473 — `axonico_comprobante_lancamento` ganha `sent_by` (change `axonico-envio-rastreavel`).
--
-- Por quê: depois de "Enviar" com sucesso, o cabeçalho do dia mostrava "Enviado — comprobante N"
-- só porque o HOOK do front (`useSendComprobanteToAxonico.ts`) decidia por ESTADO LOCAL — ao
-- recarregar a página o botão "Enviar" voltava, porque nada persistido dizia "este dia já foi
-- enviado" nem "por quem". Esta migration fecha a metade que faltava: quem disparou cada
-- tentativa (sucesso, duplicado ou erro) fica gravado, para a leitura (`GET .../patients/:id`)
-- poder devolver o mesmo dado depois de qualquer reload.
--
-- Mesmo molde de `shift_hours_validation.validated_by` (migration 437,
-- `worker-functions/migrations/437_anacare_shift_hours.sql:128`): `VARCHAR(128)` (não `UUID`) —
-- `users.firebase_uid` (a PK real de `users`, `users` não tem `id` UUID) é uma string do Firebase,
-- não um UUID. `NULL` — linhas gravadas antes desta migration ficam `NULL` (nunca inventamos um
-- autor para tentativa antiga); FK para `users(firebase_uid)` do MESMO jeito, para o JOIN de
-- exibição (`display_name`) funcionar igual ao de `shift_hours_validation`.
--
-- Sem índice: `shift_hours_validation.validated_by` também não tem índice próprio (só
-- `idx_shift_hours_validation_period`/`..._status`, nenhum por `validated_by`) — a leitura nova
-- (`findSentByDocumentAndMonth`) filtra por `document_number`/`service_type`/`service_date`, que já
-- são a chave do dedupe (`uq_axonico_lancamento_dedupe`, migration 445); `sent_by` só entra no
-- SELECT/JOIN, nunca no WHERE.
--
-- Idempotente: `ADD COLUMN IF NOT EXISTS` — pode rodar 2× no boot (Dockerfile) sem erro.
--
-- Rollback: ALTER TABLE axonico_comprobante_lancamento DROP COLUMN IF EXISTS sent_by;

BEGIN;

ALTER TABLE axonico_comprobante_lancamento
  ADD COLUMN IF NOT EXISTS sent_by VARCHAR(128) NULL REFERENCES users(firebase_uid);

COMMENT ON COLUMN axonico_comprobante_lancamento.sent_by IS
  'uid (users.firebase_uid) de quem disparou esta tentativa (enviado/duplicado/erro) — mesmo molde '
  'de shift_hours_validation.validated_by (migration 437). NULL nas linhas gravadas antes desta '
  'migration (nunca inventado). Usado pela leitura do dia (GET .../patients/:id) para mostrar '
  '"Por: <nome> · <data>" depois de qualquer reload — sem isso o front só sabia por ESTADO LOCAL, '
  'que se perdia ao recarregar.';

COMMIT;
