-- 298_message_template_drafts.sql
--
-- O rascunho de mensagem: escrito na tela, guardado aqui, e em lugar nenhum mais.
--
-- 🔒 POR QUE TABELA PRÓPRIA, E NÃO UMA COLUNA EM `message_templates`:
--
-- O sync Twilio→banco APAGA de `message_templates` toda linha cujo `content_sid`
-- não está no conjunto de aprovados da Twilio (`collectApprovedTwilio` alimenta
-- `approvedSids`, que dirige o `DELETE FROM message_templates WHERE id = $1` em
-- `diff-engine.ts`). Só 5 dos 28 slugs têm a guarda `HARDCODED_SLUGS`.
--
-- Um rascunho, POR DEFINIÇÃO, ainda não existe na Twilio. Guardá-lo na tabela
-- viva seria construir um sumidouro: a pessoa escreve, salva, e o próximo sync
-- apaga em silêncio. A separação não é organização — é o que impede a perda.
--
-- 🔒 O QUE ESTA TABELA NÃO FAZ: nada aqui sai do perímetro. Não há coluna de
-- `content_sid`, de estado da Meta, nem de "submetido em". Criar o Content na
-- Twilio (F2 passo 2.3) e submeter à Meta (2.4) são atos para fora e dependem
-- de parecer do `lex` — quando existirem, acrescentam colunas aqui, e o rascunho
-- passa a ter para onde ir. Enquanto não existirem, rascunho é só rascunho.
--
-- Aditiva: cria tabela nova, não toca nenhuma existente. Idempotente.

CREATE TABLE IF NOT EXISTS message_template_drafts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- O slug PRETENDIDO. Não é chave estrangeira para `message_templates`: o
  -- rascunho existe justamente antes de haver linha lá. A unicidade é entre
  -- rascunhos; a colisão com um template vivo é checada na aplicação, que sabe
  -- dizer "já existe uma mensagem com esse nome" em vez de estourar 23505.
  slug         VARCHAR(120) NOT NULL,

  name         VARCHAR(200) NOT NULL,
  body         TEXT         NOT NULL,
  category     VARCHAR(40)  NOT NULL,

  -- 'es-AR' | 'pt-BR'. O prefixo `ar_`/`br_` do slug é derivado daqui pela
  -- aplicação (emenda do Gabriel, 31/08: "quase SEMPRE vamos precisar das mesmas
  -- mensagens para Brasil e argentina").
  language     VARCHAR(10)  NOT NULL,

  -- Autoria: quem escreveu e quem mexeu por último. É o `uid` do staff, o mesmo
  -- que as outras tabelas de configuração guardam — não é dado de prestador nem
  -- de paciente, e nada de clínico entra aqui.
  created_by   VARCHAR(128),
  updated_by   VARCHAR(128),

  -- Trava otimista. A spec pede: "duas pessoas editando o mesmo rascunho — a
  -- segunda gravação não pode apagar a primeira sem aviso". O UPDATE exige a
  -- versão que o cliente leu; divergiu, devolve 409 e a tela avisa. Sem isso a
  -- última gravação vence em silêncio, que é a falha que a spec nomeia.
  version      INTEGER      NOT NULL DEFAULT 1,

  archived_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Um slug vivo por vez. Rascunho arquivado sai da disputa, para que o nome possa
-- ser reusado depois de um abandono — daí o índice PARCIAL e não UNIQUE simples.
CREATE UNIQUE INDEX IF NOT EXISTS message_template_drafts_slug_vivo
  ON message_template_drafts (slug)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS message_template_drafts_ordem
  ON message_template_drafts (updated_at DESC)
  WHERE archived_at IS NULL;

COMMENT ON TABLE message_template_drafts IS
  'Rascunhos de mensagem WhatsApp escritos no painel. NAO sao templates vivos: nao tem content_sid, nao foram a Twilio nem a Meta, e o sync nao os enxerga. Tabela separada de propósito — o sync apaga de message_templates o que nao esta na Twilio, e rascunho por definicao nao esta.';

COMMENT ON COLUMN message_template_drafts.version IS
  'Trava otimista. O UPDATE exige a versao lida pelo cliente; divergencia devolve 409 em vez de sobrescrever a gravacao de outra pessoa.';

COMMENT ON COLUMN message_template_drafts.language IS
  'es-AR ou pt-BR. Deriva o prefixo ar_/br_ do slug na aplicacao.';
