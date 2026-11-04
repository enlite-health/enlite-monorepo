-- 481 — quadro C (encuadre): `contracted_service_rejections`, o log de rejeição/reversão de
-- prestador NO SERVIÇO CONTRATADO (cadeia-paciente-vacante-itinerario, Fase 10; DX-10.2; D432,
-- D433 invariantes 2/6/10/11).
--
-- ── Por que não `encuadres` ───────────────────────────────────────────────────
-- `encuadres` grava por CANDIDATURA (grão de `worker_job_applications`, família `admin.encuadre`,
-- `workerEncuadreRoutes.ts`). O quadro C desta fase é calculado POR SERVIÇO (grão de
-- `patient_contracted_services`, "por vaga") — a mesma dualidade que a Fase 7 já resolveu para o
-- itinerário (`patient_itinerary_*` em vez de reusar `contracted_service_providers`). Reusar
-- `encuadres` misturaria os dois grãos e a Fase 4 (`moveReason.ts` + CHECK da migration 478) já
-- resolve o motivo do lado de B — este log é o motivo do lado de C, sem tocar B.
--
-- ── O que é (sem texto livre, sem DELETE) ─────────────────────────────────────
-- Uma marca gravada com motivo de lista fechada quando o serviço rejeita um prestador; reverter
-- grava `reverted_*` na MESMA linha (nunca `DELETE` — a tabela É o log de encuadre; rejeitar de
-- novo cria linha nova, nunca reescreve `reject_reason_category`). Nenhuma coluna de observação
-- ou texto livre (critério 17). Rejeitar prestador Em Atendimento é 422 do caso de uso (invariante
-- 10/11) — a checagem do motivo vem ANTES do banco; aqui só a trava de lista fechada. Rejeitar em
-- C não toca `worker_job_applications` nem `encuadres` (invariante 6).
--
-- ── `reject_reason_category NOT NULL` é load-bearing ──────────────────────────
-- Um CHECK `IN (…)` sozinho deixa passar NULL (o predicado dá `unknown`, não `false`) — é o
-- NOT NULL que faz a sabotagem do critério 10 morrer no banco, não o CHECK.
--
-- ── Sem DELETE para o app (mesma régua de 319:165-168, 480:33-38) ─────────────
-- O default privilege do schema (`269_app_runtime_roles.sql:66-69`) dá `arwd` a
-- `app_runtime`/`app_system` em toda tabela nova — por isso o REVOKE explícito abaixo.
--
-- ── RLS: segue o pai (molde 480:204-213) ──────────────────────────────────────
-- Tabela neta do paciente (via `patient_contracted_services`) — RLS segue o mesmo padrão da 480,
-- não o "sem RLS" da 319 (que é anterior à 411 e não neta direta na mesma árvore).
--
-- `enlite_mcp_ro` não recebe nada: o default privilege da 269 não a cita, e a tabela não entra em
-- `scripts/create-mcp-ro-role.sql`.
--
-- Idempotente (2×): `IF NOT EXISTS` / `DROP … IF EXISTS` antes de cada `ADD CONSTRAINT` /
-- `CREATE POLICY` / `CREATE TRIGGER`. Sem `BEGIN/COMMIT` próprio (molde 480/476).
--
-- Rollback: `migrations/pending/ROLLBACK_481_contracted_service_rejections.sql` (trava de dado:
-- recusa se houver marca de rejeição).

-- ── contracted_service_rejections ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contracted_service_rejections (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id             UUID         NOT NULL REFERENCES patient_contracted_services(id) ON DELETE CASCADE,
  worker_id              UUID         NOT NULL REFERENCES workers(id),
  rejected_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  rejected_by            VARCHAR(128) NOT NULL,
  reject_reason_category TEXT         NOT NULL,
  reverted_at            TIMESTAMPTZ  NULL,
  reverted_by            VARCHAR(128) NULL,
  revert_reason_category TEXT         NULL,
  country                TEXT         NULL,  -- etapa 1: trigger abaixo preenche; etapa 2: NOT NULL; etapa 3: CHECK
  created_by             VARCHAR(128) NOT NULL,
  updated_by             VARCHAR(128) NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT csr_reject_reason_check CHECK (
    reject_reason_category IN ('PERFIL_INADEQUADO_AO_SERVICO', 'INDISPONIBILIDADE_DE_HORARIO', 'DESISTENCIA_DO_PRESTADOR', 'OTHER')
  ),
  CONSTRAINT csr_revert_reason_check CHECK (
    revert_reason_category IS NULL OR revert_reason_category IN ('REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER')
  ),
  CONSTRAINT csr_revert_has_reason CHECK (reverted_at IS NULL OR revert_reason_category IS NOT NULL),
  CONSTRAINT csr_revert_has_actor CHECK ((reverted_at IS NULL) = (reverted_by IS NULL))
);

-- Um prestador não fica rejeitado duas vezes ao mesmo tempo no mesmo serviço; reverter libera o
-- par para nova rejeição (linha nova, nunca reescrita). Índice parcial — não representável como
-- `ADD CONSTRAINT UNIQUE` (molde 480:103-106).
CREATE UNIQUE INDEX IF NOT EXISTS uq_csr_active_pair
  ON contracted_service_rejections (service_id, worker_id) WHERE reverted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_csr_worker ON contracted_service_rejections (worker_id);

-- ── country: 3 etapas (molde 480:112-155) ────────────────────────────────────
-- Etapa 1: trigger BEFORE INSERT copia o país do pai (só quando NEW.country IS NULL).
CREATE OR REPLACE FUNCTION fn_csr_country_from_service()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT pcs.country INTO NEW.country FROM patient_contracted_services pcs WHERE pcs.id = NEW.service_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_csr_country ON contracted_service_rejections;
CREATE TRIGGER trg_csr_country
  BEFORE INSERT ON contracted_service_rejections
  FOR EACH ROW EXECUTE FUNCTION fn_csr_country_from_service();

-- Etapa 2: NOT NULL só depois do trigger existir (a tabela nasce vazia nesta árvore).
ALTER TABLE contracted_service_rejections ALTER COLUMN country SET NOT NULL;

-- Etapa 3: CHECK do país.
ALTER TABLE contracted_service_rejections DROP CONSTRAINT IF EXISTS csr_country_check;
ALTER TABLE contracted_service_rejections
  ADD CONSTRAINT csr_country_check CHECK (country IN ('AR', 'BR'));

-- ── RLS: segue o serviço (molde 480:204-213) ──────────────────────────────────
ALTER TABLE contracted_service_rejections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contracted_service_rejections_follow_service ON contracted_service_rejections;
CREATE POLICY contracted_service_rejections_follow_service ON contracted_service_rejections FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_contracted_services pcs WHERE pcs.id = contracted_service_rejections.service_id)
);

-- ── GRANT/REVOKE (molde 480:225-227) — sem DELETE para o app ─────────────────
GRANT SELECT, INSERT, UPDATE ON contracted_service_rejections TO app_runtime, app_system;
REVOKE DELETE ON contracted_service_rejections FROM app_runtime, app_system;

COMMENT ON TABLE contracted_service_rejections IS
  'Quadro C (encuadre) calculado por serviço: log de rejeição/reversão de prestador no serviço '
  'contratado (Fase 10, DX-10.2; D432, D433 invariantes 2/6/10/11). Por que não encuadres: aquela '
  'tabela grava por candidatura (grão de worker_job_applications); esta grava por serviço (grão de '
  'patient_contracted_services) — mesma dualidade que patient_itinerary_* resolveu para B na Fase '
  '7. Sem texto livre. Sem DELETE: reverter grava reverted_*, rejeitar de novo cria linha nova. '
  'Não toca worker_job_applications nem encuadres (invariante 6). Rollback: '
  'migrations/pending/ROLLBACK_481_contracted_service_rejections.sql.';
COMMENT ON COLUMN contracted_service_rejections.country IS
  'Herdado de patient_contracted_services.country por trigger (etapa 1/3). NOT NULL (etapa 2/3) + CHECK AR/BR (etapa 3/3).';
