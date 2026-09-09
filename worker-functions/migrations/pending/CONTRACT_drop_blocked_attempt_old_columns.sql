-- CONTRACT_drop_blocked_attempt_old_columns.sql
--
-- FASE 2 de 2 do rename honesto (ver 332). Metade CONTRACT de um expand/contract.
--
-- 🔒 NÃO RODAR JUNTO COM A 332. Esta migration só é segura depois que o deploy do
-- código que escreve APENAS as colunas novas estiver 100% no ar — nenhuma revisão
-- velha do Cloud Run servindo tráfego. Rodar antes derruba o INSERT de quem tenta
-- se candidatar.
--
-- Ordem: 332 → deploy → (conferir revisão única no Cloud Run) → esta.
--
-- 🔒 E DEPOIS DESTA MIGRATION, ROLLBACK DE REVISÃO DEIXA DE SER SEGURO.
-- A conferência de "revisão única" acima protege o ANTES. Nada protegia o DEPOIS:
-- num incidente qualquer, voltar a revisão anterior é um clique e é a resposta padrão
-- — só que aquele código faz `INSERT ... blocked_reason` contra coluna que já não
-- existe, e `RecordBlockedAttemptUseCase` é fire-and-forget: engole no `catch`, devolve
-- `[]`, loga `warn`. Toda tentativa de candidatura barrada durante o rollback SOME —
-- sem 500 para a pessoa, sem alerta. É exatamente a perda que o runner passou a falhar
-- fechado para evitar, entrando pela outra porta.
--
-- Caminho de volta correto a partir daqui: **redeploy da revisão nova** (ou revert do
-- commit + deploy), nunca `gcloud run services update-traffic` para a revisão velha.
-- Quem libera esta migration avisa o time disso na hora.
-- Como liberar: ver `migrations/pending/README.md` (mover para `migrations/` com o
-- próximo número livre; o nome aqui não tem número de propósito).
--
-- O QUE ESTA MIGRATION COMPRA
-- Depois dela, `WHERE b.blocked_reason = '...'` deixa de devolver resposta errada
-- e passa a devolver ERRO. É o conserto da CAUSA, não da instância: o nome no
-- presente era o convite, e o índice era a facilidade. Some com os dois.
--
-- ⚠️ Esta é a única migration desta dupla que NÃO é aditiva. A regra da casa é
-- "nunca dropar coluna sem deprecação" — a deprecação é a 332 + o deploy entre as
-- duas. O dado não se perde: foi copiado para `*_at_attempt` e o backfill abaixo
-- fecha a janela.
--
-- 🔒 POR QUE CADA PASSO É RE-EXECUTÁVEL (e por que isso não é zelo, é obrigação)
-- `scripts/run-migration-prod.sh` roda o psql e NÃO escreve em `schema_migrations`
-- (conferido: o script termina no `psql --file`). Então, assim que este arquivo for
-- movido para `migrations/`, o runner do CMD do Dockerfile o vê como não-aplicado e
-- o RE-EXECUTA no próximo boot. Uma versão não-idempotente aqui explodiria no
-- `UPDATE` contra a coluna que ela mesma acabou de dropar — e, com o runner agora
-- falhando fechado (`exit != 0`), isso deixa de ser barulho e vira NENHUMA
-- INSTÂNCIA SUBINDO. O guard de existência abaixo é o que separa as duas coisas.

BEGIN;

-- ── FECHA A JANELA ────────────────────────────────────────────────────────────
--
-- A 332 deliberadamente NÃO backfillou (ver o bloco lá). Por isso a leitura aqui é
-- inequívoca, e não um palpite:
--
--   at_attempt IS NULL      → o código NOVO nunca escreveu esta linha. Ou ela é
--                             histórica, ou quem a escreveu na janela foi a revisão
--                             VELHA. Nos dois casos a coluna antiga é a verdade.
--   at_attempt IS NOT NULL  → o código NOVO escreveu. Ele é o único que escreve
--                             essa coluna, então ela é a verdade.
--
-- `COALESCE(at_attempt, antiga)` é exatamente essa regra.
--
-- ⚠️ O ÚNICO caso imperfeito, dito sem enfeite: a mesma linha escrita pelas DUAS
-- revisões durante a janela, com a VELHA escrevendo por último. Aí guardamos o valor
-- da escrita anterior — o instantâneo fica UMA tentativa defasado. Não há como
-- distinguir: as duas revisões bombam `updated_at`, e não existe timestamp por
-- coluna.
--
-- Por que isso é aceitável, e por que ABORTAR não era:
--   · o dano é um campo HISTÓRICO uma tentativa defasado, em poucas linhas. Desde o
--     PR #324 nenhuma tela lê esta coluna — todas recalculam ao vivo.
--   · a janela é o rolling deploy (minutos), e o caso exige DUAS escritas na MESMA
--     linha nesses minutos, uma por cada revisão.
--   · a versão anterior abortava quando as colunas divergiam, chamando isso de
--     "divergência esperada: ZERO". Medido em produção em 09/09: 30 reescritas em
--     24 h, 170 em 7 dias, 1.180 das 1.727 linhas com mais de uma tentativa.
--     Retentativa é a NORMA — o aborto dispararia de rotina. E aborto aqui, uma vez
--     que o arquivo esteja em `migrations/`, é `process.exit(1)` no boot do Cloud
--     Run: NENHUMA INSTÂNCIA SOBE. Trocar campo histórico defasado por apagão de
--     produção é o pior negócio possível.
--
-- O guard é por EXISTÊNCIA das colunas antigas (com `table_schema`, senão uma tabela
-- homônima noutro schema responde por esta), e o `EXECUTE` garante que o SQL nem
-- chega a ser planejado quando o ramo está morto — na segunda execução as colunas
-- já não existem.
DO $$
DECLARE v_divergentes INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'worker_blocked_applications'
       AND column_name  = 'blocked_reason'
  ) THEN
    RAISE NOTICE 'Colunas antigas já removidas — nada a fechar (re-execução).';
    RETURN;
  END IF;

  -- Só para quem está olhando a saída do psql: quantas linhas tiveram atividade das
  -- duas revisões na janela. NOTICE, nunca EXCEPTION — é informação, não corrupção.
  EXECUTE $sql$
    SELECT COUNT(*) FROM worker_blocked_applications
     WHERE blocked_reason IS NOT NULL
       AND blocked_reason_at_attempt IS NOT NULL
       AND (blocked_reason IS DISTINCT FROM blocked_reason_at_attempt
         OR missing_fields IS DISTINCT FROM missing_fields_at_attempt)
  $sql$ INTO v_divergentes;

  IF v_divergentes > 0 THEN
    RAISE NOTICE
      '% linha(s) foram escritas pelas duas revisões durante a janela. Fica o valor '
      'que o código NOVO gravou. Se precisar auditar, compare blocked_reason x '
      'blocked_reason_at_attempt ANTES de rodar isto — o DROP abaixo é definitivo.',
      v_divergentes;
  END IF;

  EXECUTE $sql$
    UPDATE worker_blocked_applications
       SET blocked_reason_at_attempt = COALESCE(blocked_reason_at_attempt, blocked_reason),
           missing_fields_at_attempt = COALESCE(missing_fields_at_attempt, missing_fields)
     WHERE blocked_reason_at_attempt IS NULL
        OR missing_fields_at_attempt IS NULL
  $sql$;
END $$;

-- Trava de segurança. AQUI o fail-closed é o certo, e a diferença em relação ao caso
-- acima é o ponto: divergência entre as colunas é TRÁFEGO NORMAL; linha sem valor em
-- NENHUMA das duas é impossível pelo código (a revisão velha sempre grava o par
-- antigo, a nova sempre grava o novo) e significa escrita à mão ou corrupção. Dropar
-- ali apagaria a única pista do que era aquela tentativa, e não há nada a recuperar
-- depois.
--
-- ⚠️ Correção de uma premissa errada que esta migration afirmava: dizia que sobrar
-- linha sem valor é impossível porque `blocked_reason` é NOT NULL desde a 209. A 332
-- deste mesmo PR derruba esse NOT NULL — ela precisa, porque o código novo escreve
-- só as colunas `*_at_attempt`.
--
-- 🔒 Para que este aborto NUNCA vire boot quebrado, o README de `migrations/pending/`
-- manda rodar este arquivo AINDA em `pending/` e só movê-lo para `migrations/` (com
-- registro em `schema_migrations`) DEPOIS de ele ter passado.
DO $$
DECLARE v_pendentes INT;
BEGIN
  SELECT COUNT(*) INTO v_pendentes
    FROM worker_blocked_applications
   WHERE blocked_reason_at_attempt IS NULL;
  IF v_pendentes > 0 THEN
    RAISE EXCEPTION
      'ABORTADO: % linha(s) sem blocked_reason_at_attempt e sem blocked_reason para '
      'recuperar. Isso não sai do código — investigue essas linhas antes de liberar '
      'esta migration. Dropar agora apagaria a única pista do que era a tentativa.',
      v_pendentes;
  END IF;
END $$;

-- O índice morre junto: ele existia para servir `WHERE blocked_reason = ...`, que
-- é justamente a consulta que não deve mais existir. Deixá-lo seria manter o
-- convite de pé apontando para uma coluna que já não responde a pergunta certa.
DROP INDEX IF EXISTS idx_wba_blocked_reason;

ALTER TABLE worker_blocked_applications
  DROP COLUMN IF EXISTS blocked_reason,
  DROP COLUMN IF EXISTS missing_fields;

-- Agora os invariantes da coluna antiga cabem, e TODOS entram: NOT NULL nas duas
-- (a 209 exigia isso desde sempre) e o DEFAULT que a 332 deliberadamente adiou
-- para não estragar o backfill da janela.
UPDATE worker_blocked_applications
   SET missing_fields_at_attempt = '[]'::jsonb
 WHERE missing_fields_at_attempt IS NULL;

ALTER TABLE worker_blocked_applications
  ALTER COLUMN blocked_reason_at_attempt SET NOT NULL,
  ALTER COLUMN missing_fields_at_attempt SET NOT NULL,
  ALTER COLUMN missing_fields_at_attempt SET DEFAULT '[]'::jsonb;

COMMIT;
