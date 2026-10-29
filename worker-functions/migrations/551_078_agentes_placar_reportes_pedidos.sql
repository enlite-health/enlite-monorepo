-- Migration 551: schema `agentes` — placar, reportes e fila de pedidos (spec 078, M3a-1, Q2 do plano-M3)
--
-- 9 tabelas INSERT-only + 1 view. Nenhum texto de conversa mora aqui (D514: o dado é único e
-- a conversa tem dono — a inbox): veredicto/achado/reporte guardam REFERÊNCIAS (ids, slugs, hashes)
-- e campos curtos com teto de tamanho no banco. "Status" de pedido NUNCA é coluna: é a view
-- `agentes.pedido_status` (último evento). A auditoria da decisão (item 51) é a própria
-- `pedido_eventos`; o id de aprovação (itens 20/48) é o `id` do evento `aceitar`, preso ao `atitude_id`.
--
-- INSERT-only no BANCO: REVOKE UPDATE, DELETE, TRUNCATE das roles do app (app_runtime/app_system) e
-- dos logins reais (prd: enlite_app = DB_USER e também o dono das tabelas — backend-prd.yml;
-- stg/prd futuro: enlite_runtime/enlite_system). Revogar do dono vale para o PRIVILÉGIO EXPLÍCITO:
-- o dono ainda pode re-conceder (é DDL, não DML) — por isso o teste prova como app_runtime.
-- Grants EXPLÍCITOS por tabela, sem ALTER DEFAULT PRIVILEGES (324; molde 271/274/419).
--
-- RLS: toda tabela habilitada. Policy no molde da 461: sistema (app.system_context + membro de
-- app_system) passa; sessão de staff (app.user_uid presente, molde 548) passa. A restrição por ÁREA
-- (o gestor só vê a sua) vem na rota/capability nesta fase — não é RLS (M2).
--
-- `area` e `operador`: text com CHECK de tamanho (<= 40). Catálogo (FK) fica para decidir.
-- Idempotente (2x). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_551_078_agentes_placar_reportes_pedidos.sql`.

CREATE SCHEMA IF NOT EXISTS agentes;

-- ── 1. veredictos — a conversa avaliada ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agentes.veredictos (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  operador       text        NOT NULL CHECK (char_length(operador) BETWEEN 1 AND 40),
  sensor         text        NOT NULL CHECK (sensor IN ('silente','handover_orfao','juiz','scrubber','notario')),
  inbox          text        NOT NULL CHECK (char_length(inbox) BETWEEN 1 AND 40),
  conversa_ref   text        NOT NULL CHECK (char_length(conversa_ref) BETWEEN 1 AND 80),
  ultima_msg_ref text        NOT NULL CHECK (char_length(ultima_msg_ref) BETWEEN 1 AND 80),
  nota           smallint    CHECK (nota BETWEEN 0 AND 10),
  cruza_areas    boolean     NOT NULL,
  juiz_versao    text        CHECK (char_length(juiz_versao) BETWEEN 1 AND 40),
  avaliado_em    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT veredictos_nota_so_do_juiz   CHECK ((sensor = 'juiz') = (nota IS NOT NULL)),
  CONSTRAINT veredictos_versao_so_do_juiz CHECK ((sensor = 'juiz') = (juiz_versao IS NOT NULL)),
  CONSTRAINT veredictos_uma_por_ultima_msg UNIQUE (sensor, inbox, conversa_ref, ultima_msg_ref)
);

-- ── 2. veredicto_achados — cada violação/acerto (sem texto) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS agentes.veredicto_achados (
  id           uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  veredicto_id uuid     NOT NULL REFERENCES agentes.veredictos(id),
  tipo         text     NOT NULL CHECK (tipo IN ('violacao','acerto')),
  regra_ref    text     NOT NULL CHECK (char_length(regra_ref) BETWEEN 3 AND 120),
  gravidade    text     CHECK (gravidade IN ('baixa','media','alta')),
  CONSTRAINT achados_gravidade_so_da_violacao CHECK ((tipo = 'violacao') = (gravidade IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_veredicto_achados_veredicto ON agentes.veredicto_achados (veredicto_id);

-- ── 3. reportes — o aviso do gestor (sem trecho de conversa) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS agentes.reportes (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  autor          text        NOT NULL CHECK (char_length(autor) BETWEEN 1 AND 80),
  operador       text        NOT NULL CHECK (char_length(operador) BETWEEN 1 AND 40),
  area           text        NOT NULL CHECK (char_length(area) BETWEEN 1 AND 40),
  observacao     text        NOT NULL CHECK (char_length(observacao) BETWEEN 1 AND 500),
  regra_proposta text        CHECK (char_length(regra_proposta) BETWEEN 1 AND 300),
  criado_em      timestamptz NOT NULL DEFAULT now()
);

-- ── 4. reporte_veredictos — a evidência por ID (M:N) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agentes.reporte_veredictos (
  reporte_id   uuid NOT NULL REFERENCES agentes.reportes(id),
  veredicto_id uuid NOT NULL REFERENCES agentes.veredictos(id),
  PRIMARY KEY (reporte_id, veredicto_id)
);

-- ── 5. pedidos — a proposta na fila ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agentes.pedidos (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  assunto         text        NOT NULL CHECK (char_length(assunto) BETWEEN 1 AND 200),
  descricao       text        NOT NULL CHECK (char_length(descricao) BETWEEN 1 AND 1000),
  autor           text        NOT NULL CHECK (char_length(autor) BETWEEN 1 AND 80),
  area            text        NOT NULL CHECK (char_length(area) BETWEEN 1 AND 40),
  grave_gatilho   text        NOT NULL DEFAULT 'nenhum' CHECK (grave_gatilho IN ('nenhum','nunca','dado','acao_fabricada')),
  registro_versao text        NOT NULL CHECK (char_length(registro_versao) BETWEEN 1 AND 40),
  criado_em       timestamptz NOT NULL DEFAULT now()
);

-- ── 6. pedido_atitudes — cada versão da atitude (formato da regra 2 da fila) ──────────────────────
CREATE TABLE IF NOT EXISTS agentes.pedido_atitudes (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id        uuid        NOT NULL REFERENCES agentes.pedidos(id),
  versao           integer     NOT NULL CHECK (versao >= 1),
  degrau           smallint    NOT NULL CHECK (degrau BETWEEN 0 AND 4),
  conteudo         text        NOT NULL CHECK (char_length(conteudo) BETWEEN 1 AND 4000),
  caso_teste       text        NOT NULL CHECK (char_length(caso_teste) BETWEEN 1 AND 1000),
  metrica_alvo     text        NOT NULL CHECK (char_length(metrica_alvo) BETWEEN 1 AND 120),
  janela           text        NOT NULL CHECK (char_length(janela) BETWEEN 1 AND 80),
  gatilho_rollback text        NOT NULL CHECK (char_length(gatilho_rollback) BETWEEN 1 AND 300),
  criado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pedido_atitudes_versao_unica UNIQUE (pedido_id, versao),
  CONSTRAINT pedido_atitudes_id_pedido    UNIQUE (id, pedido_id)
);

-- ── 7. pedido_origens — de onde veio (M:N; ou reporte ou veredicto; texto nunca copiado) ───────────
CREATE TABLE IF NOT EXISTS agentes.pedido_origens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id    uuid NOT NULL REFERENCES agentes.pedidos(id),
  reporte_id   uuid REFERENCES agentes.reportes(id),
  veredicto_id uuid REFERENCES agentes.veredictos(id),
  CONSTRAINT pedido_origens_um_so CHECK (num_nonnulls(reporte_id, veredicto_id) = 1)
);
CREATE INDEX IF NOT EXISTS ix_pedido_origens_pedido ON agentes.pedido_origens (pedido_id);

-- ── 8. pedido_eventos — cada decisão = a auditoria do item 51 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS agentes.pedido_eventos (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id  uuid        NOT NULL REFERENCES agentes.pedidos(id),
  atitude_id uuid        NOT NULL,
  acao       text        NOT NULL CHECK (acao IN ('aceitar','negar','descrever')),
  actor_uid  text        NOT NULL CHECK (char_length(actor_uid) BETWEEN 1 AND 128),
  actor_kind text        NOT NULL CHECK (actor_kind IN ('humano','agente','sistema')),
  motivo     text        CHECK (char_length(motivo) BETWEEN 1 AND 300),
  comentario text        CHECK (char_length(comentario) BETWEEN 1 AND 500),
  ts         timestamptz NOT NULL DEFAULT now(),
  -- a atitude decidida é DESTE pedido (sem isso o aceitar de um pedido prenderia a atitude de outro)
  CONSTRAINT pedido_eventos_atitude_do_pedido FOREIGN KEY (atitude_id, pedido_id)
    REFERENCES agentes.pedido_atitudes (id, pedido_id),
  -- agente nunca decide, por baixo da célula
  CONSTRAINT pedido_eventos_so_humano_decide CHECK (actor_kind = 'humano'),
  CONSTRAINT pedido_eventos_negar_exige_motivo CHECK (acao <> 'negar' OR motivo IS NOT NULL),
  CONSTRAINT pedido_eventos_descrever_exige_comentario CHECK (acao <> 'descrever' OR comentario IS NOT NULL)
);
-- 1 decisão (aceitar OU negar) por atitude; `descrever` pode repetir.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pedido_eventos_uma_decisao_por_atitude
  ON agentes.pedido_eventos (atitude_id) WHERE acao IN ('aceitar','negar');
CREATE INDEX IF NOT EXISTS ix_pedido_eventos_pedido_ts ON agentes.pedido_eventos (pedido_id, ts DESC);

-- ── 9. medicoes — fotos datadas de números que mudam ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agentes.medicoes (
  id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  metrica   text        NOT NULL CHECK (char_length(metrica) BETWEEN 1 AND 120),
  escopo    text        NOT NULL CHECK (char_length(escopo) BETWEEN 1 AND 80),
  de        timestamptz NOT NULL,
  ate       timestamptz NOT NULL,
  valor     numeric     NOT NULL,
  n         integer     NOT NULL CHECK (n >= 0),
  motivo    text        NOT NULL CHECK (motivo IN ('linha_de_base','antes','depois')),
  medido_em timestamptz NOT NULL DEFAULT now(),
  pedido_id uuid        REFERENCES agentes.pedidos(id),
  CONSTRAINT medicoes_periodo_valido CHECK (de <= ate),
  CONSTRAINT medicoes_sem_pedido_so_linha_de_base CHECK ((pedido_id IS NULL) = (motivo = 'linha_de_base'))
);
CREATE INDEX IF NOT EXISTS ix_medicoes_pedido ON agentes.medicoes (pedido_id) WHERE pedido_id IS NOT NULL;

-- ── 10. view de status: o último evento do pedido (nunca coluna) ──────────────────────────────────
-- security_invoker: a view respeita a RLS de quem lê (455), não a do dono.
CREATE OR REPLACE VIEW agentes.pedido_status WITH (security_invoker = true) AS
SELECT p.id AS pedido_id,
       CASE (SELECT e.acao FROM agentes.pedido_eventos e WHERE e.pedido_id = p.id ORDER BY e.ts DESC, e.id DESC LIMIT 1)
         WHEN 'aceitar'   THEN 'aceito'
         WHEN 'negar'     THEN 'negado'
         WHEN 'descrever' THEN 'redirecionado'
         ELSE 'novo'
       END AS status
  FROM agentes.pedidos p;

-- ── 11. RLS (molde 461): sistema passa; staff com identidade passa ────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['veredictos','veredicto_achados','reportes','reporte_veredictos','pedidos',
                           'pedido_atitudes','pedido_origens','pedido_eventos','medicoes']
  LOOP
    EXECUTE format('ALTER TABLE agentes.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON agentes.%I', t || '_sistema_ou_staff', t);
    EXECUTE format($p$CREATE POLICY %I ON agentes.%I FOR ALL USING (
        (NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
         AND pg_has_role(current_user, 'app_system', 'MEMBER'))
        OR NULLIF(current_setting('app.user_uid', true), '') IS NOT NULL
      )$p$, t || '_sistema_ou_staff', t);
  END LOOP;
END $$;

-- ── 12. Grants explícitos + INSERT-only ───────────────────────────────────────────────────────────
DO $$
DECLARE
  r text;
  roles text[] := ARRAY[]::text[];
BEGIN
  -- app_runtime/app_system (269) + logins reais quando existirem: enlite_app (prd, DB_USER e dono),
  -- enlite_runtime/enlite_system (stg e prd pós-virada).
  FOREACH r IN ARRAY ARRAY['app_runtime','app_system','enlite_app','enlite_runtime','enlite_system'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN roles := roles || r; END IF;
  END LOOP;

  FOREACH r IN ARRAY roles LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA agentes TO %I', r);
    EXECUTE format('GRANT SELECT, INSERT ON agentes.veredictos, agentes.veredicto_achados, agentes.reportes,
      agentes.reporte_veredictos, agentes.pedidos, agentes.pedido_atitudes, agentes.pedido_origens,
      agentes.pedido_eventos, agentes.medicoes TO %I', r);
    EXECUTE format('GRANT SELECT ON agentes.pedido_status TO %I', r);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA agentes FROM %I', r);
  END LOOP;
END $$;

COMMENT ON SCHEMA agentes IS
  'Pessoas artificiais (spec 078): placar, reportes e fila de pedidos. INSERT-only para o app; sem texto de conversa.';
COMMENT ON VIEW agentes.pedido_status IS
  'Status do pedido = ação do ÚLTIMO evento: sem evento novo; aceitar aceito; negar negado; descrever redirecionado.';
