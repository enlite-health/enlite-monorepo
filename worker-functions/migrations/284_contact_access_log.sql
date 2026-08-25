-- 284_contact_access_log.sql
--
-- POR QUÊ: a condição C6 do veredito do `lex` (0.2) pede trilha para o acesso a
-- CONTATO de prestador nas rotas de listagem — Kanban, funil, match e detalhe de
-- vaga. Hoje esse acesso não deixa rastro nenhum: a escrita é atribuível desde a
-- D95, a leitura de dossiê tem `resource_access_log`, mas "quem viu o nome e o
-- telefone de quais prestadores" é ponto cego.
--
-- COMO **NÃO** fazer: marcar `funnel`/`match`/`vacancy` como recurso sensível em
-- `SENSITIVE_RESOURCES`. Uma recrutadora abre o Kanban dezenas de vezes por dia;
-- isso geraria uma linha de ALLOW por abertura, encheria a partição de ruído e
-- ESCONDERIA justamente as linhas que a trilha existe para destacar — abertura
-- de dossiê, exclusão, export. A C6 proíbe isso em letra, e há guarda de teste.
--
-- COMO **também não** fazer: uma linha por prestador em `resource_access_log`.
-- Mesmo problema de volume (um Kanban devolve dezenas de cards), e aquela tabela
-- é uma linha por recurso por desenho — o `resource_id` alimenta um
-- `SELECT country FROM workers WHERE id = $1`.
--
-- COMO fazer: UMA linha por REQUEST, agregada, com o conjunto de prestadores
-- cujo contato de fato atravessou. Volume passa de O(prestadores) para
-- O(requests), e a pergunta que a auditoria precisa responder — "quem viu o
-- contato de quem, e quando" — continua respondível por `worker_ids @> ARRAY[x]`.
--
-- ⚠️ O QUE A LINHA NÃO GUARDA, e cada ausência é uma condição, não um esquecimento:
--   · TELEFONE e qualquer contato em claro — a trilha guarda o VÍNCULO
--     (operador↔prestador), não o dado. Guardar o dado faria da trilha uma
--     segunda cópia daquilo que ela existe para vigiar.
--   · PATH CRU — só a célula (`worker_contact:read`). O path carrega
--     identificador de vaga e, cruzado com o log de request do Cloud Run,
--     reconstrói mais do que a linha deveria dizer (mesma razão da M1-5, que
--     proíbe `traceId` no `staff_access`).
--   · CORPO, query string, IP, user-agent.
--
-- ⚠️ SÓ ENTRA LINHA QUANDO O CONTATO DE FATO SAIU. Request em que a projeção
-- redigiu tudo não gera registro: nada foi revelado, e registrar "tentou ver"
-- transformaria a trilha de acesso numa trilha de comportamento — que é outro
-- tratamento, com outra base legal, e a política de finalidade
-- (`politica-staff-access.md`, M1-2) proíbe expressamente uso disciplinar.
--
-- Retenção: 30 dias, igual ao ensaio (M1-4). O DELETE é feito pelo mesmo job que
-- já poda `permission_audit_log` — sem sink de export (⛔ BigQuery = PARE, M1-4).

CREATE TABLE IF NOT EXISTS iam.contact_access_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES iam.tenants(id),
  occurred_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  operator_uid  VARCHAR(128) NOT NULL,
  cell          VARCHAR(64)  NOT NULL,
  worker_ids    UUID[]       NOT NULL,
  n             INTEGER      NOT NULL,
  country       VARCHAR(2),
  CONSTRAINT contact_access_log_n_bate CHECK (n = cardinality(worker_ids)),
  CONSTRAINT contact_access_log_nao_vazia CHECK (n > 0)
);

COMMENT ON TABLE iam.contact_access_log IS
  'C6: uma linha por REQUEST em que contato de prestador atravessou a fronteira. '
  'Agregada de propósito (worker_ids + n) — uma linha por prestador encheria a '
  'partição e esconderia as trilhas de dossiê. Sem telefone, sem path cru.';
COMMENT ON COLUMN iam.contact_access_log.worker_ids IS
  'Prestadores cujo contato SAIU nesta request. Consulta por titular: '
  'WHERE worker_ids @> ARRAY[<uuid>]::uuid[] — é o que responde ao direito de '
  'acesso do titular (25.326 art. 14; LGPD art. 18 II).';
COMMENT ON COLUMN iam.contact_access_log.n IS
  'cardinality(worker_ids), materializado para agregação sem unnest. O CHECK '
  'impede que os dois divirjam — número que mente é pior que número ausente.';
COMMENT ON COLUMN iam.contact_access_log.cell IS
  'A célula que autorizou (ex.: worker_contact:read). NUNCA o path: o path leva '
  'identificador de vaga e, cruzado com o log de request, diz mais do que deve.';

-- Consulta por titular (direito de acesso) — GIN é o índice de array.
CREATE INDEX IF NOT EXISTS contact_access_log_worker_ids_idx
  ON iam.contact_access_log USING GIN (worker_ids);
-- Consulta por operador numa janela (é como a F11 vai montar os grupos).
CREATE INDEX IF NOT EXISTS contact_access_log_operador_idx
  ON iam.contact_access_log (tenant_id, operator_uid, occurred_at DESC);
-- Poda por retenção.
CREATE INDEX IF NOT EXISTS contact_access_log_occurred_at_idx
  ON iam.contact_access_log (occurred_at);

-- A aplicação INSERE e não lê; leitura é do auditor, pela função do 283.
-- ⚠️ Sem GRANT de UPDATE/DELETE a `app_runtime`: trilha é append-only, e o
-- operador não pode apagar o próprio rastro (25.326 art. 9).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT INSERT ON iam.contact_access_log TO app_runtime, app_system;
    GRANT SELECT ON iam.contact_access_log TO app_system;
  END IF;
END
$$;
