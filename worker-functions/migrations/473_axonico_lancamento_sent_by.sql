-- 473 — `axonico_comprobante_lancamento` ganha `sent_by` (change `axonico-envio-rastreavel`).
--
-- Por quê: depois de "Enviar" com sucesso, o cabeçalho do dia mostrava "Enviado — comprobante N"
-- só porque o HOOK do front (`useSendComprobanteToAxonico.ts`) decidia por ESTADO LOCAL — ao
-- recarregar a página o botão "Enviar" voltava, porque nada persistido dizia "este dia já foi
-- enviado" nem "por quem". Esta migration fecha a metade que faltava: quem disparou cada
-- tentativa (sucesso, duplicado ou erro) fica gravado, para a leitura (`GET .../patients/:id`)
-- poder devolver o mesmo dado depois de qualquer reload.
--
-- `VARCHAR(128)` (não `UUID`) — mesmo tipo de `shift_hours_validation.validated_by` (migration
-- 437): `users.firebase_uid` (a PK real de `users`) é uma string do Firebase, não um UUID. `NULL`
-- — linhas gravadas antes desta migration ficam `NULL` (nunca inventamos um autor para tentativa
-- antiga).
--
-- CORREÇÃO (25/09/2026, achado A1 do gate `revisao-pr`, ANTES do merge — esta coluna nunca rodou
-- em produção): a versão original desta migration levava `REFERENCES users(firebase_uid)`, copiando
-- o molde de `validated_by` sem reparar numa diferença real entre os dois casos. `validated_by`
-- é gravado por uma ação de UI (validar turno) que só um staff logado no PAINEL aciona — o caminho
-- de auth ali já teve chance de casar o uid com uma linha de `users`. `sent_by` é gravado no meio
-- de um POST que já FATUROU no Axonico (o `PUT /api/comprobante` já aconteceu, não tem como
-- desfazer) — e o uid que chega em `principal.id` (`FirebaseAuthStrategy.authenticateProduction`)
-- é o `decodedToken.uid` do JWT, não necessariamente uma linha de `users`: (a) quando o JWT já
-- carrega os claims `role`+`account_type`, `getIdentityFromDB` nem roda — não há confirmação
-- nenhuma de que aquele uid tem linha em `users` (`FirebaseAuthStrategy.ts:74-78`); (b) quando roda,
-- o SELECT casa por `firebase_uid = $1 OR email = $2` (`:110`) — uma linha achada só pelo E-MAIL
-- (uid trocado/legado) tem um `firebase_uid` DIFERENTE do `decodedToken.uid` que vira `sent_by`,
-- e a FK ainda estoura. Medido no e2e real (`axonico-lancamento.e2e.test.ts` contra Postgres real):
-- com a FK, esses casos faziam o INSERT do `enviado` estourar 23503 DEPOIS do `PUT` já ter faturado
-- — perdendo o registro local, o dedupe local (a próxima tentativa refaturaria) e o "Enviado" da
-- tela, exatamente o cenário que esta feature existe para evitar. Decisão: `sent_by` é TRILHA
-- (quem disparou, para exibição — "Por: <nome> · <data>"), não um INVARIANTE RELACIONAL que pode
-- vetar a gravação de um faturamento que já aconteceu. Vira `VARCHAR(128) NULL` simples, sem FK —
-- um uid sem linha em `users` grava normalmente, e a LEITURA (`findSentByDocumentAndMonth`) já
-- usa `LEFT JOIN` (nunca `INNER`), então `sentByName` sai `null` e a tela mostra só a data, nunca
-- quebra. `DROP CONSTRAINT IF EXISTS` cobre quem já rodou a versão anterior desta MESMA migration
-- (nunca chegou a produção, mas pode ter rodado em banco local/CI) — nome confirmado empiricamente
-- (`\d axonico_comprobante_lancamento` num banco onde a versão anterior rodou):
-- `axonico_comprobante_lancamento_sent_by_fkey` (convenção padrão do Postgres,
-- `<tabela>_<coluna>_fkey`, pra FK sem nome explícito).
--
-- Sem índice: `shift_hours_validation.validated_by` também não tem índice próprio — a leitura
-- (`findSentByDocumentAndMonth`) filtra por `document_number`/`service_type`/`service_date`, que já
-- são a chave do dedupe (`uq_axonico_lancamento_dedupe`, migration 445); `sent_by` só entra no
-- SELECT/JOIN, nunca no WHERE.
--
-- Idempotente (prova: rodei este arquivo 2× num banco que já tinha a FK da versão anterior E 2×
-- num banco limpo — as 4 corridas terminam sem erro, coluna presente, sem FK):
--   `ADD COLUMN IF NOT EXISTS` — no-op se a coluna já existe (de qualquer uma das duas versões).
--   `DROP CONSTRAINT IF EXISTS` — no-op se a FK nunca existiu ou já foi removida.
--
-- Rollback: ALTER TABLE axonico_comprobante_lancamento DROP COLUMN IF EXISTS sent_by;

BEGIN;

ALTER TABLE axonico_comprobante_lancamento
  ADD COLUMN IF NOT EXISTS sent_by VARCHAR(128) NULL;

ALTER TABLE axonico_comprobante_lancamento
  DROP CONSTRAINT IF EXISTS axonico_comprobante_lancamento_sent_by_fkey;

COMMENT ON COLUMN axonico_comprobante_lancamento.sent_by IS
  'uid (users.firebase_uid, SEM FK — ver correção 25/09/2026 no cabeçalho da migration 473) de '
  'quem disparou esta tentativa (enviado/duplicado/erro). NULL nas linhas gravadas antes desta '
  'migration, ou quando o uid autenticado não tem linha em users (JWT com claims role+account_type '
  'nunca consulta o banco, ou linha casada só por e-mail com outro firebase_uid — ver '
  'FirebaseAuthStrategy). Trilha para exibição ("Por: <nome> · <data>"), nunca invariante '
  'relacional: a tentativa já fatura no Axonico ANTES deste INSERT, e não pode falhar por causa de '
  'um uid sem linha correspondente. Leitura sempre por LEFT JOIN — sem a linha, sentByName é null.';

COMMIT;
