-- 302_message_template_drafts_base_name.sql
--
-- A CHAVE DO PAR no rascunho — o que faltava para o compositor da Tela 2 existir.
--
-- 🔒 O QUE ELA DESTRAVA. O desenho de 31/08 pede que a pessoa digite o nome UMA
-- vez e veja nascer as duas versões (`ar_x` e `br_x`), escrevendo espanhol e
-- português em abas lado a lado. Isso é UMA mensagem em DUAS linhas desta
-- tabela — e, sem uma coluna que as una, a tela não tem como reabrir o par
-- depois: ela receberia dois rascunhos sem nenhuma relação declarada entre eles.
--
-- 🔒 POR QUE AQUI O BACKFILL PODE SER DERIVADO, e na 300 não podia.
--
-- A 300 teve de ENUMERAR 28 linhas à mão porque `message_templates` mistura três
-- convenções (prefixo `ar_`, sufixo `_es`/`_pt`, e 12 linhas sem marcador
-- nenhum) — nasceram no Console da Twilio, ao longo de meses, sem regra.
--
-- Esta tabela é o oposto: TODA linha dela foi criada pela nossa tela, e o slug
-- passou obrigatoriamente por `slugComPrefixo(base, idioma)`
-- (`templateDraftRules.ts:207`), que aplica `ar_`/`br_` e é idempotente. Não há
-- caminho de escrita que produza outra forma — a rota de criação e a de edição
-- chamam a mesma função. Derivar aqui não é adivinhar: é desfazer uma
-- transformação que este código fez, e cujo inverso é exato.
--
-- ⚠️ A guarda contra o caso que sobra: linha SEM o prefixo esperado fica com
-- `base_name = slug`. Ela não pareia com ninguém — o que é a verdade — em vez de
-- ser forçada num par errado. Mesma escolha do `COALESCE(base_name, slug)` que a
-- 300 usa na leitura.
--
-- Aditiva, nullable, idempotente. Não toca nenhuma linha de `message_templates`.

ALTER TABLE message_template_drafts
  ADD COLUMN IF NOT EXISTS base_name VARCHAR(120);

-- Backfill: desfaz o prefixo que `slugComPrefixo` aplicou. Só toca quem ainda
-- está NULL, para a migration poder rodar de novo sem reescrever nada.
UPDATE message_template_drafts
   SET base_name = CASE
     WHEN slug LIKE 'ar\_%' THEN substring(slug FROM 4)
     WHEN slug LIKE 'br\_%' THEN substring(slug FROM 4)
     -- Sem prefixo reconhecido, a mensagem é um par de uma só. Verdade, não erro.
     ELSE slug
   END
 WHERE base_name IS NULL;

-- Pareia por base E idioma: duas versões da MESMA mensagem no MESMO idioma não
-- existem — seriam dois Contents disputando o mesmo lugar. Parcial pelo mesmo
-- motivo do índice de slug: rascunho arquivado sai da disputa, para o nome poder
-- ser reusado depois de um abandono.
CREATE UNIQUE INDEX IF NOT EXISTS message_template_drafts_par_vivo
  ON message_template_drafts (base_name, language)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS message_template_drafts_base
  ON message_template_drafts (base_name)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN message_template_drafts.base_name IS
  'A chave que une a versao espanhola e a portuguesa da MESMA mensagem. E o nome que a pessoa digitou, ANTES do prefixo ar_/br_ que slugComPrefixo aplica. Nunca derivar o par do slug na leitura: use esta coluna.';
