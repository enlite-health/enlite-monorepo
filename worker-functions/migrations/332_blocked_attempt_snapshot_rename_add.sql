-- 332_blocked_attempt_snapshot_rename_add.sql
--
-- FASE 1 de 2 do rename honesto de `worker_blocked_applications` (D300).
--
-- POR QUE ESTE RENAME EXISTE
-- `blocked_reason` e `missing_fields` guardam um INSTANTÂNEO: o motivo da barrada
-- no momento em que ela aconteceu, escrito uma vez e nunca mais atualizado. Mas o
-- NOME está no presente. Quem escreve uma consulta nova lê `blocked_reason`,
-- entende "o motivo", e faz `WHERE b.blocked_reason = '...'` — sintaxe certa,
-- pergunta errada. Foi assim que 135 de 1.271 cards em produção passaram meses
-- exibindo um rótulo velho, 90 deles escondendo gente com cadastro completo.
--
-- O caminho barato tinha nome de verdade e ainda tinha índice convidando
-- (`idx_wba_blocked_reason`). O caminho certo exige um LEFT JOIN e um helper.
-- Enquanto for assim, o próximo leitor erra de novo — consertar a instância não
-- conserta a classe.
--
-- Depois da fase 2, `WHERE b.blocked_reason` vira ERRO DO POSTGRES em vez de
-- resposta errada. É o ponto inteiro: transformar falha silenciosa em ruidosa.
--
-- ⚠️ POR QUE DUAS FASES, E NÃO UM `RENAME COLUMN`
-- Migration aqui é MANUAL (`scripts/run-migration-prod.sh`), separada do deploy, e
-- o Cloud Run troca revisão de forma gradual: durante a janela, revisão velha e
-- nova servem tráfego ao mesmo tempo. Um `RENAME` puro quebraria o INSERT da
-- revisão que ainda estivesse de pé — e esse INSERT é o de quem TENTOU se
-- candidatar. Um 500 ali é a pessoa perdendo a tentativa em silêncio, que é
-- exatamente a classe de dano que esta frente inteira existe para remover.
--
-- ORDEM OBRIGATÓRIA:
--   1. esta migration (aditiva — a revisão velha continua funcionando)
--   2. deploy do código que escreve SÓ as colunas novas
--   3. migration 333 (backfill da janela + DROP das antigas + do índice morto)
--
-- Entre 1 e 2 as duas colunas coexistem; entre 2 e 3 a coluna velha só recebe
-- escrita de revisão velha que ainda não saiu. A 333 fecha isso.

BEGIN;

-- Nomes que dizem a verdade: o valor é do momento da TENTATIVA, não de agora.
ALTER TABLE worker_blocked_applications
  ADD COLUMN IF NOT EXISTS blocked_reason_at_attempt VARCHAR(64),
  ADD COLUMN IF NOT EXISTS missing_fields_at_attempt JSONB;

-- Backfill do histórico inteiro. Sem WHERE: são ~1.700 linhas, e deixar linha
-- antiga com o campo novo nulo criaria um terceiro estado ("não sei se foi
-- migrada") — que é a ambiguidade que já apagou dado nesta casa antes.
UPDATE worker_blocked_applications
   SET blocked_reason_at_attempt = blocked_reason,
       missing_fields_at_attempt = missing_fields
 WHERE blocked_reason_at_attempt IS NULL
    OR missing_fields_at_attempt IS NULL;

COMMENT ON COLUMN worker_blocked_applications.blocked_reason_at_attempt IS
  'INSTANTÂNEO: motivo no momento da tentativa. NÃO é o estado atual — para o '
  'motivo de HOJE use blockedAttemptLiveState (liveBlockedReasonSql), que espelha '
  'assertWorkerCanApply. Escrito uma vez por tentativa e nunca recalculado.';

COMMENT ON COLUMN worker_blocked_applications.missing_fields_at_attempt IS
  'INSTANTÂNEO: campos que faltavam no momento da tentativa. Para os de HOJE use '
  'fn_worker_missing_fields via liveMissingFieldsSql. Nunca recalculado aqui.';

COMMIT;
