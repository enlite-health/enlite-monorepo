-- Migration 553: aviso do pedido do Sol — tipos de notificação + trilha de envio (spec 078, M3b-2, decisão 25 / itens 53, 55, 57)
--
-- 1) Tipos de notificação (molde 507/548): PEDIDO_IA_NOVO (todo pedido depositado) e PEDIDO_IA_GRAVE (caso GRAVE).
--    Convenção da plataforma: code em MAIÚSCULAS. O payload dos dois é vazio ('{}'): o aviso nunca carrega assunto/descrição/PII.
-- 2) `agentes.avisos_enviados` — UMA linha por envio (in-app OU WhatsApp). INSERT-only no BANCO, como as irmãs da 551.
--    `destinatario_ref`: uid (canal inapp) ou sha256 do número salgado com o uid (canal twilio) — NUNCA o número em claro.
--    `motivo`: slug curto de falha (nunca o texto do erro do Twilio, que pode ecoar o número).
--    UNIQUE (pedido_id, canal, destinatario_ref, tentativa): o reenvio é no máximo UM (tentativa ∈ {1,2}) e o banco barra o 3º.
--
-- RLS e grants no molde da 551 (sistema passa; staff com identidade passa; grants explícitos, REVOKE UPDATE/DELETE).
-- Idempotente (2x). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_553_078_avisos_graves.sql`.
--
-- ⚠️ INCIDENTE 30/10/2026 (deploy de prd, revisão worker-functions-00607-xrq: `permission denied for table pedidos`).
-- A 551 faz `REVOKE ... REFERENCES ... ON ALL TABLES IN SCHEMA agentes FROM enlite_app`, e enlite_app é o DONO das tabelas em prd
-- (o dono também perde o privilégio quando o revoga de si). A FK `REFERENCES agentes.pedidos(id)` abaixo exige o privilégio
-- REFERENCES na tabela referenciada — por isso falhava só em prd/owner-não-superuser (CI e suítes rodam como superuser e não pegam).
-- Conserto: conceder REFERENCES em agentes.pedidos ao executor (current_user) SÓ durante o CREATE TABLE e revogar logo depois,
-- devolvendo o estado da 551 (INSERT-only; nada de UPDATE/DELETE concedido).

INSERT INTO notification_types (code, description) VALUES
  ('PEDIDO_IA_NOVO',  'Aviso automático: um pedido novo do Sol aguarda decisão na página de pedidos (sem assunto nem texto)'),
  ('PEDIDO_IA_GRAVE', 'Aviso automático: pedido GRAVE do Sol aguarda decisão (sem assunto nem texto; o mesmo aviso sai por WhatsApp)')
ON CONFLICT (code) DO NOTHING;

DO $$ BEGIN EXECUTE format('GRANT REFERENCES ON agentes.pedidos TO %I', current_user); END $$;

CREATE TABLE IF NOT EXISTS agentes.avisos_enviados (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id        uuid        NOT NULL REFERENCES agentes.pedidos(id),
  canal            text        NOT NULL CHECK (canal IN ('inapp','twilio')),
  destinatario_ref text        NOT NULL CHECK (char_length(destinatario_ref) BETWEEN 1 AND 128),
  tentativa        smallint    NOT NULL CHECK (tentativa IN (1,2)),
  template_ref     text        NOT NULL CHECK (char_length(template_ref) BETWEEN 1 AND 80),
  enviado_em       timestamptz NOT NULL DEFAULT now(),
  resultado        text        NOT NULL CHECK (resultado IN ('ok','falha','stub')),
  motivo           text        CHECK (char_length(motivo) BETWEEN 1 AND 60),
  CONSTRAINT avisos_enviados_unico UNIQUE (pedido_id, canal, destinatario_ref, tentativa),
  CONSTRAINT avisos_enviados_motivo_so_na_falha CHECK ((resultado = 'falha') = (motivo IS NOT NULL)),
  -- o aviso in-app não se reenvia: só o WhatsApp tem tentativa 2
  CONSTRAINT avisos_enviados_inapp_uma_vez CHECK (canal <> 'inapp' OR tentativa = 1)
);
CREATE INDEX IF NOT EXISTS ix_avisos_enviados_pedido ON agentes.avisos_enviados (pedido_id);

-- volta ao estado da 551 (sem REFERENCES); a FK já foi criada e não precisa do privilégio para existir
DO $$ BEGIN EXECUTE format('REVOKE REFERENCES ON agentes.pedidos FROM %I', current_user); END $$;

ALTER TABLE agentes.avisos_enviados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avisos_enviados_sistema_ou_staff ON agentes.avisos_enviados;
CREATE POLICY avisos_enviados_sistema_ou_staff ON agentes.avisos_enviados FOR ALL USING (
  (NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
   AND pg_has_role(current_user, 'app_system', 'MEMBER'))
  OR NULLIF(current_setting('app.user_uid', true), '') IS NOT NULL
);

DO $$
DECLARE
  r text;
  roles text[] := ARRAY[]::text[];
BEGIN
  FOREACH r IN ARRAY ARRAY['app_runtime','app_system','enlite_app','enlite_runtime','enlite_system'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN roles := roles || r; END IF;
  END LOOP;
  FOREACH r IN ARRAY roles LOOP
    EXECUTE format('GRANT SELECT, INSERT ON agentes.avisos_enviados TO %I', r);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON agentes.avisos_enviados FROM %I', r);
  END LOOP;
END $$;

COMMENT ON TABLE agentes.avisos_enviados IS
  'Trilha de aviso do pedido do Sol (1 linha por envio, in-app ou WhatsApp). INSERT-only. Sem número em claro, sem texto do pedido.';
