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
-- ⚠️ A coluna nova herda TUDO que a antiga tinha, não só o tipo. A varredura de
-- dependências (08/09) achou duas coisas que um `ADD COLUMN` ingênuo perderia em
-- silêncio no DROP da 333:
--   · `worker_blocked_applications_reason_check` — CHECK dos 3 motivos do gate
--   · `DEFAULT '[]'::jsonb` em missing_fields
-- Perder um CHECK não quebra nada na hora: só deixa entrar valor inválido depois,
-- que é a falha silenciosa outra vez.
ALTER TABLE worker_blocked_applications
  ADD COLUMN IF NOT EXISTS blocked_reason_at_attempt VARCHAR(64),
  ADD COLUMN IF NOT EXISTS missing_fields_at_attempt JSONB;
-- ⚠️ O DEFAULT '[]' da coluna antiga NÃO entra aqui — entra só na 333, depois que a
-- janela fecha. Motivo medido: com DEFAULT, a linha que a revisão VELHA grava nesta
-- janela nasce com `'[]'` em vez de NULL, e o `COALESCE(nova, antiga)` do backfill
-- da 333 devolve `'[]'` — apagando os campos faltantes reais, dentro do COMMIT e
-- sem erro. Provado: ["first_name","phone","worker_documents"] virava [].
-- Foi o commit que "herdou tudo" que criou esse caminho. Herdar sem pensar em
-- QUANDO é a mesma classe de descuido que esta frente inteira está consertando.

-- Os 3 valores são os do GATE (`WorkerEligibilityReason`). `eligible` NÃO entra:
-- ele é estado calculado na leitura e nunca é gravado — se um dia aparecer aqui,
-- é bug, e o CHECK é quem avisa.
ALTER TABLE worker_blocked_applications
  DROP CONSTRAINT IF EXISTS worker_blocked_applications_reason_at_attempt_check;
ALTER TABLE worker_blocked_applications
  ADD CONSTRAINT worker_blocked_applications_reason_at_attempt_check
  CHECK (blocked_reason_at_attempt IS NULL OR blocked_reason_at_attempt IN
         ('worker_not_found', 'registration_incomplete', 'worker_disabled'));

-- Backfill do histórico inteiro. Sem WHERE: são ~1.700 linhas, e deixar linha
-- antiga com o campo novo nulo criaria um terceiro estado ("não sei se foi
-- migrada") — que é a ambiguidade que já apagou dado nesta casa antes.
UPDATE worker_blocked_applications
   SET blocked_reason_at_attempt = blocked_reason,
       missing_fields_at_attempt = missing_fields
 WHERE blocked_reason_at_attempt IS NULL
    OR missing_fields_at_attempt IS NULL;

-- 🔒 A PEÇA SEM A QUAL A JANELA NÃO FUNCIONA.
--
-- `blocked_reason` e `missing_fields` são NOT NULL desde a 209. O código NOVO
-- escreve apenas as colunas `*_at_attempt` — então, enquanto as antigas existirem
-- com NOT NULL e sem DEFAULT, TODO INSERT de tentativa bloqueada morre com
-- `null value in column "blocked_reason" violates not-null constraint`.
--
-- Ou seja: sem isto, a janela entre esta migration e a 333 derruba exatamente o
-- caminho de quem está tentando se candidatar — o dano que este desenho existe
-- para evitar, só que vindo da outra direção (código novo × schema intermediário).
-- Medido: a suíte de banco ficou vermelha por isso antes deste bloco existir.
--
-- Afrouxar é seguro: a revisão VELHA continua preenchendo as duas, e a 333 dropa
-- as colunas logo depois.
ALTER TABLE worker_blocked_applications
  ALTER COLUMN blocked_reason DROP NOT NULL,
  ALTER COLUMN missing_fields DROP NOT NULL;

COMMENT ON COLUMN worker_blocked_applications.blocked_reason_at_attempt IS
  'INSTANTÂNEO: motivo no momento da tentativa. NÃO é o estado atual — para o '
  'motivo de HOJE use blockedAttemptLiveState (liveBlockedReasonSql), que espelha '
  'assertWorkerCanApply. Escrito uma vez por tentativa e nunca recalculado.';

COMMENT ON COLUMN worker_blocked_applications.missing_fields_at_attempt IS
  'INSTANTÂNEO: campos que faltavam no momento da tentativa. Para os de HOJE use '
  'fn_worker_missing_fields via liveMissingFieldsSql. Nunca recalculado aqui.';

COMMIT;
