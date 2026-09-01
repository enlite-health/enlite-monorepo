-- 300_message_templates_language_pair.sql
--
-- O idioma e a CHAVE DO PAR da mensagem — as duas colunas que faltavam para a
-- listagem ser "uma linha por MENSAGEM" em vez de "uma linha por template".
--
-- 🔒 POR QUE ISTO É ENUMERADO À MÃO, E NÃO DERIVADO DO SLUG:
--
-- O desenho canônico ("Registro de Plantillas") diz, com todas as letras, que
-- não dá para deduzir o par do slug. Medido contra produção em 01/09/2026, o
-- problema é ainda maior do que o exemplo que ele cita — as 28 linhas usam
-- TRÊS convenções, e uma delas é "nenhuma":
--
--   prefixo `ar_`          12   ar_invite_open, ar_vacancy_match_complete, …
--   SEM MARCADOR NENHUM    12   qualified_worker_request, complete_register_ofc, …
--   sufixo `_es`            2   admission_confirmation_es, admission_reminder_es
--   sufixo `_pt`            2   admission_confirmation_pt, admission_reminder_pt
--   prefixo `br_`           0
--
-- Repare na inversão: os ÚNICOS dois pares ES/PT que já existem usam SUFIXO —
-- a convenção OPOSTA à de prefixo que a tela nova aplica. Qualquer regex que
-- acertasse um grupo erraria o outro, e para 12 linhas não há o que casar.
--
-- Por isso a decisão do Gabriel em 01/09 foi: não deduzir, ENUMERAR. São 28
-- linhas, cada uma revisável. O par passa a ser decisão humana registrada, e
-- não o resultado de um `substring` que ninguém consegue auditar depois.
--
-- 🔒 A ALTERNATIVA DESCARTADA, e o motivo medido: apagar as mensagens e
-- recriá-las na convenção nova. Três delas enviaram de verdade em 26/08/2026
-- (`ar_vacancy_match_incomplete` 174 envios, `qualified_worker_request` 77,
-- `ar_vacancy_match_complete` 21), o slug é literal no código de envio
-- (`QualifiedInterviewHandler.ts:163`, `VacancyAutoInviteHandler.ts:9-10`,
-- `VacancyInviteGuard.ts:3-4`), e recriar significa 28 submissões novas à Meta
-- — irreversíveis, com o nome queimado na WABA mesmo em caso de recusa, e com
-- risco para a nota de qualidade do número por onde a Luz fala.
--
-- 🔒 DE ONDE VEM O `language` DAS 12 SEM MARCADOR: da operação, não do slug —
-- e corroborado. A conferência de 01/09 contra a Content API achou 23 `es_AR`,
-- 3 `es` e 2 `pt_BR` nos 28 Contents: 26 em espanhol e 2 em português. Esta
-- enumeração dá exatamente 26 `es-AR` e 2 `pt-BR`. Os números batem — não é
-- chute confirmando a si mesmo.
--
-- 🔒 `_v2` NÃO É SUFIXO DE IDIOMA e NÃO é removido do `base_name`.
-- `ar_vacancy_match_complete` e `ar_vacancy_match_complete_v2` são duas
-- mensagens diferentes, não duas versões de idioma da mesma. Colapsá-las
-- poria dois textos espanhóis na mesma coluna de espanhol, e a segunda
-- desapareceria da tela.
--
-- Aditiva: só acrescenta colunas e preenche. Não apaga linha, não renomeia
-- slug, não toca em `content_sid` nem em nada que a Meta já aprovou.

-- 🔒 TRANSAÇÃO EXPLÍCITA, e não é enfeite. O `run-migration-prod.sh` chama o
-- psql com `ON_ERROR_STOP=1` mas SEM transação: cada statement daria commit
-- sozinho, e uma falha no meio deixaria a tabela com as colunas criadas e o
-- backfill pela metade — 28 linhas em que algumas têm `base_name` e outras não,
-- que é justamente o estado que a listagem não sabe representar.
--
-- Todos os statements aqui são transacionais no Postgres (ALTER, COMMENT,
-- UPDATE e CREATE INDEX não-concorrente), então ou entra tudo ou não entra nada.

BEGIN;

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS language  VARCHAR(10),
  ADD COLUMN IF NOT EXISTS base_name VARCHAR(120);

COMMENT ON COLUMN message_templates.language IS
  'es-AR | pt-BR. NULL = idioma não registrado (linha criada pelo sync a partir do Console da Twilio). NULL é "não sei", e a tela diz isso — nunca vira es-AR por omissão.';
COMMENT ON COLUMN message_templates.base_name IS
  'A chave que une a versão espanhola e a portuguesa da MESMA mensagem. NÃO é derivável do slug: ver o cabeçalho da migration 300. NULL = linha ainda não classificada; a leitura usa COALESCE(base_name, slug), que nunca pareia errado — só não pareia.';

-- O backfill das 28 linhas de produção em 01/09/2026.
--
-- `WHERE base_name IS NULL` torna a migration idempotente E preserva
-- classificação feita depois por gente: rodar duas vezes não desfaz nada.
UPDATE message_templates AS t
   SET language  = v.language,
       base_name = v.base_name
  FROM (VALUES
    -- ── os DOIS pares que já existem, por sufixo. São a razão de a coluna
    --    existir: hoje aparecem como quatro coisas sem relação na tela.
    ('admission_confirmation_es',     'es-AR', 'admission_confirmation'),
    ('admission_confirmation_pt',     'pt-BR', 'admission_confirmation'),
    ('admission_reminder_es',         'es-AR', 'admission_reminder'),
    ('admission_reminder_pt',         'pt-BR', 'admission_reminder'),

    -- ── prefixo `ar_`: o prefixo sai do base_name para que a futura versão
    --    `br_…` caia na mesma linha da tela.
    ('ar_finalize_signup_direct',     'es-AR', 'finalize_signup_direct'),
    ('ar_finalize_signup_luz',        'es-AR', 'finalize_signup_luz'),
    ('ar_invite_luz_personal',        'es-AR', 'invite_luz_personal'),
    ('ar_invite_open',                'es-AR', 'invite_open'),
    ('ar_invite_poetic',              'es-AR', 'invite_poetic'),
    ('ar_presentacion_invite',        'es-AR', 'presentacion_invite'),
    ('ar_signup_pending_reminder',    'es-AR', 'signup_pending_reminder'),
    ('ar_signup_pending_reminder_v2', 'es-AR', 'signup_pending_reminder_v2'),
    ('ar_vacancy_match_complete',     'es-AR', 'vacancy_match_complete'),
    ('ar_vacancy_match_complete_v2',  'es-AR', 'vacancy_match_complete_v2'),
    ('ar_vacancy_match_incomplete',   'es-AR', 'vacancy_match_incomplete'),
    ('ar_vacancy_match_incomplete_v2','es-AR', 'vacancy_match_incomplete_v2'),

    -- ── sem marcador nenhum. O `base_name` É o slug: não há prefixo nem
    --    sufixo para tirar, e inventar um agruparia mensagens sem relação.
    --    Quando a versão brasileira de uma delas nascer pela tela, ela virá
    --    como `br_<algo>` e precisará de `base_name` igual ao daqui — é
    --    decisão de quem criar, e a tela mostra o base_name para isso.
    ('complete_register_ofc',         'es-AR', 'complete_register_ofc'),
    ('complete_register_utility',     'es-AR', 'complete_register_utility'),
    ('complete_register_utility_v2',  'es-AR', 'complete_register_utility_v2'),
    ('qualified_reminder_confirm',    'es-AR', 'qualified_reminder_confirm'),
    ('qualified_reminder_reason',     'es-AR', 'qualified_reminder_reason'),
    ('qualified_reminder_reschedule', 'es-AR', 'qualified_reminder_reschedule'),
    ('qualified_reprogram_confirm',   'es-AR', 'qualified_reprogram_confirm'),
    ('qualified_worker',              'es-AR', 'qualified_worker'),
    ('qualified_worker_request',      'es-AR', 'qualified_worker_request'),
    ('qualified_worker_response',     'es-AR', 'qualified_worker_response'),
    ('talentum_incomplete_reminder',  'es-AR', 'talentum_incomplete_reminder'),
    ('talentum_incomplete_reminder_v2','es-AR','talentum_incomplete_reminder_v2')
  ) AS v(slug, language, base_name)
 WHERE t.slug = v.slug
   AND t.base_name IS NULL;

-- Índice para a listagem, que agrupa por base_name e ordena por ele.
--
-- 🔒 NÃO é UNIQUE de propósito. Um UNIQUE(base_name, language) daria a garantia
-- desejável, mas o sync Twilio→banco INSERE linhas vindas do Console, e um
-- 23505 ali derrubaria o sync inteiro por causa de uma classificação — trocar
-- "duas linhas parecidas" por "nenhuma linha sincronizada" é pior.
CREATE INDEX IF NOT EXISTS idx_message_templates_base_name
    ON message_templates (base_name, language);

COMMIT;
