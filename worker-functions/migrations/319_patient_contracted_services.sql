-- 319 — `patient_contracted_services`: o serviço contratado como ENTIDADE PRÓPRIA
-- (spec 013, bloco C — US-C1; decisão 1 do Gabriel em 03/09: "entidade própria; vaga referencia")
--
-- ── O que esta tabela substitui ─────────────────────────────────────────────
-- Hoje `patients.service_type[]` (139) é a única forma de saber QUE serviço um paciente tem —
-- um array sem quantidade, sem local, sem prestador, sem valor. A tela (`ServicosContratadosCard`)
-- já desenha 7 colunas; 5 delas são fantasma (`#PEND-08`: nunca houve dado por trás). Esta
-- migration cria o dado real; `patients.service_type[]` PASSA A SER DERIVADO dela (321/trigger
-- nesta mesma migration) quando existir ao menos 1 serviço — o espelho ClickUp continua
-- escrevendo o array quando não há serviço (compat, FR-C1).
--
-- ── `country NOT NULL` sem `DEFAULT` (lex C-a.1) ────────────────────────────
-- Mesmo desenho da 316 (`patient_addresses`): tabela por paciente leva `country` para a RLS da
-- F1 (ainda não ligada — `grep 'ROW LEVEL SECURITY' migrations/` = 0, lex C-a.2). Sem DEFAULT
-- (a pegadinha do F0: 8 tabelas com `DEFAULT 'AR'` já mediram o risco). Trigger BEFORE INSERT
-- deriva de `patients.country` quando o escritor não informa; o controller do painel passa
-- explicitamente mesmo assim.
--
-- ── `created_by`/`updated_by` (lex C-a.3) ───────────────────────────────────
-- NOT NULL, diferente do molde de `additional_comments_updated_by` (nullable, 286): aqui TODO
-- caminho de escrita é o painel admin autenticado (não há sync automático que crie o serviço),
-- então exigir o uid na mesma transação é reforço, não fricção nova.
--
-- ── Baixa é `active=false` + `ended_at`, NUNCA DELETE (lex C-a.4) ───────────
-- Sem rota DELETE (ver AdminPatientContractedServicesController). O purge do paciente (D248,
-- `PatientTestFixtureService`) leva a linha por CASCADE — `patient_id` está em
-- CASCADE_CHILDREN a partir deste commit.
--
-- ── `professional_profile` (lex C-b1/C-b2) ──────────────────────────────────
-- Texto livre, teto 2000. NUNCA alimenta `job_postings.worker_profile_sought` — caminho 1 do
-- PARE C-b2: da entidade para a vaga propagam só campos codificados (321). Guarda de fronteira:
-- `guardaVazamentoClinico.ts`.
--
-- ── `hourly_value` (lex C-c) ─────────────────────────────────────────────────
-- Finalidade declarada (C-c.1, linha nova em `registro-operacoes.md` antes deste INSERT):
-- preço do CONTRATO cobrado à família/obra social — NÃO remuneração do prestador (C-c.2).
-- Leitura só admin; redigido para os demais papéis staff (API, molde D181/local
-- `patientClinicalAccess.ts`). NUNCA alimenta `job_postings.salary_text` (C-c.3).
--
-- ── `provider_sex` NÃO ENTRA (lex C-d) ───────────────────────────────────────
-- Fora desta rodada — precisa de decisão datada do Gabriel nomeando "sexo" (D191 é sobre idade).
--
-- ── `contract_type`/`tax_condition` migraram do bloco B (lex C3.3) ─────────
-- São do CONTRATO/pagador, não do paciente — moram aqui, não em `patients`.
--
-- Rollback: DROP TRIGGER/FUNCTION de país; DROP TABLE patient_contracted_services; — nasce vazia
-- nesta árvore.

CREATE TABLE IF NOT EXISTS patient_contracted_services (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id              UUID        NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  service_code            TEXT        NOT NULL REFERENCES service_types(code) ON UPDATE CASCADE,

  -- Texto livre sobre o profissional buscado — NUNCA alimenta worker_profile_sought (lex C-b2).
  professional_profile    TEXT        NULL,
  providers_needed        INT         NULL,
  authorized_hours        NUMERIC     NULL,
  weekly_hours            NUMERIC     NULL,
  care_location           TEXT        NULL,
  -- Preço do contrato à família/obra social (lex C-c.2) — leitura só admin, redigido no servidor.
  hourly_value            NUMERIC     NULL,
  version                 TEXT        NULL,
  start_date              DATE        NULL,
  contract_type           TEXT        NULL,
  tax_condition            TEXT        NULL,
  supervision_frequency   TEXT        NULL,
  guard_shift              TEXT        NULL,

  active                  BOOLEAN     NOT NULL DEFAULT true,
  ended_at                TIMESTAMPTZ NULL,

  country                 TEXT        NULL,  -- NOT NULL aplicada no fim, depois do trigger (molde 316)
  created_by              VARCHAR(128) NOT NULL,
  updated_by              VARCHAR(128) NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pcs_professional_profile_len
    CHECK (professional_profile IS NULL OR length(professional_profile) <= 2000),
  CONSTRAINT pcs_providers_needed_positivo
    CHECK (providers_needed IS NULL OR providers_needed > 0),
  CONSTRAINT pcs_authorized_hours_nao_negativo
    CHECK (authorized_hours IS NULL OR authorized_hours >= 0),
  CONSTRAINT pcs_weekly_hours_nao_negativo
    CHECK (weekly_hours IS NULL OR weekly_hours >= 0),
  CONSTRAINT pcs_hourly_value_nao_negativo
    CHECK (hourly_value IS NULL OR hourly_value >= 0),
  CONSTRAINT pcs_care_location_check
    CHECK (care_location IS NULL OR care_location IN ('HOME', 'SCHOOL', 'INSTITUTION', 'OTHER')),
  CONSTRAINT pcs_contract_type_check
    CHECK (contract_type IS NULL OR contract_type IN ('OBRA_SOCIAL', 'PREPAGA', 'PRIVATE')),
  CONSTRAINT pcs_tax_condition_check
    CHECK (tax_condition IS NULL OR tax_condition IN ('IVA_EXEMPT', 'IVA_10_5', 'IVA_21')),
  CONSTRAINT pcs_supervision_frequency_check
    CHECK (supervision_frequency IS NULL OR supervision_frequency IN ('DAYS_15', 'DAYS_30', 'DAYS_45', 'BIMONTHLY')),
  CONSTRAINT pcs_guard_shift_check
    CHECK (guard_shift IS NULL OR guard_shift IN ('EARLY_MORNING', 'MORNING', 'EARLY_AFTERNOON', 'AFTERNOON', 'NIGHT', 'FULL_DAY')),
  -- Molde device_types_retired_coerente (307): as duas colunas de baixa não podem se contradizer.
  CONSTRAINT pcs_active_ended_coerente
    CHECK ((active AND ended_at IS NULL) OR (NOT active AND ended_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_patient_contracted_services_patient
  ON patient_contracted_services (patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_contracted_services_active
  ON patient_contracted_services (patient_id, active);
CREATE INDEX IF NOT EXISTS idx_patient_contracted_services_country
  ON patient_contracted_services (country);

CREATE OR REPLACE FUNCTION fn_patient_contracted_services_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_contracted_services_country ON patient_contracted_services;
CREATE TRIGGER trg_patient_contracted_services_country
  BEFORE INSERT ON patient_contracted_services
  FOR EACH ROW EXECUTE FUNCTION fn_patient_contracted_services_country_from_patient();

ALTER TABLE patient_contracted_services ALTER COLUMN country SET NOT NULL;

ALTER TABLE patient_contracted_services DROP CONSTRAINT IF EXISTS pcs_country_check;
ALTER TABLE patient_contracted_services
  ADD CONSTRAINT pcs_country_check CHECK (country IN ('AR', 'BR'));

COMMENT ON TABLE patient_contracted_services IS
  'O serviço contratado por um paciente, como ENTIDADE (spec 013, bloco C; decisão 1 do Gabriel '
  '03/09). Satélite de patients, country herdado por trigger (lex C-a.1). Baixa = active=false + '
  'ended_at, nunca DELETE (C-a.4); some junto do paciente no purge D248 (C-a.4). '
  'professional_profile NUNCA alimenta job_postings.worker_profile_sought (C-b2); hourly_value '
  'NUNCA alimenta job_postings.salary_text, leitura só admin (C-c). Dado tocado: sensível-saúde.';
COMMENT ON COLUMN patient_contracted_services.professional_profile IS
  'Perfil do profissional buscado, texto livre teto 2000 — campo do SERVIÇO, rota admin, máscara '
  'Clarity no textarea (lex C-b1). NUNCA em log/erro. NUNCA alimenta worker_profile_sought.';
COMMENT ON COLUMN patient_contracted_services.hourly_value IS
  'Preço do CONTRATO cobrado à família/obra social (lex C-c.2 — NÃO é remuneração do prestador). '
  'Leitura só admin; redigido no servidor para recruiter/community_manager. NUNCA alimenta '
  'job_postings.salary_text (C-c.3). Dado pessoal, não sensível.';
COMMENT ON COLUMN patient_contracted_services.country IS
  'Jurisdição do serviço (AR|BR), NOT NULL sem DEFAULT. Derivada de patients.country por trigger '
  '(lex C-a.1, molde 316).';


-- ── Junção: dispositivo(s) do serviço (many-to-many com device_types, 307) ──
CREATE TABLE IF NOT EXISTS contracted_service_devices (
  service_id   UUID NOT NULL REFERENCES patient_contracted_services(id) ON DELETE CASCADE,
  device_type  TEXT NOT NULL REFERENCES device_types(code) ON UPDATE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT contracted_service_devices_pkey PRIMARY KEY (service_id, device_type)
);

CREATE INDEX IF NOT EXISTS idx_contracted_service_devices_type
  ON contracted_service_devices (device_type, service_id);

COMMENT ON TABLE contracted_service_devices IS
  'Conjunto de dispositivos do serviço contratado (spec 013). Cascata do serviço (ON DELETE '
  'CASCADE) — sai junto quando o serviço sai (purge do paciente, D248).';


-- ── Junção: prestador(es) alocado(s) no serviço ─────────────────────────────
-- Dado: pessoal do prestador + sensível por associação (lex C-e — vincula prestador nomeado a
-- paciente com condição de saúde). Surrogate PK (não (service_id, worker_id)): o mesmo par pode
-- ser alocado, desativado e realocado depois — cada alocação é uma linha própria, histórico
-- preservado (C-e.2, "fim de alocação = active=false + ended_at, nunca DELETE" — o histórico de
-- quem esteve com o paciente é trilha, não lixo).
CREATE TABLE IF NOT EXISTS contracted_service_providers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id    UUID        NOT NULL REFERENCES patient_contracted_services(id) ON DELETE CASCADE,
  worker_id     UUID        NOT NULL REFERENCES workers(id),
  -- weekly_hours da ALOCAÇÃO — NÃO é registro de jornada (lex C-e.3). Se o produto quiser usá-la
  -- como base de ponto/pagamento (check-in/checkout do roadmap), é outro tratamento e volta ao
  -- lex antes. Nenhum serviço de ponto/pagamento lê esta coluna hoje (grep: 0 ocorrências fora
  -- deste módulo, medido 03/09).
  weekly_hours  NUMERIC     NULL,
  active        BOOLEAN     NOT NULL DEFAULT true,
  ended_at      TIMESTAMPTZ NULL,
  country       TEXT        NULL,  -- NOT NULL aplicada no fim (molde acima); herda do SERVIÇO (do paciente), não do worker
  created_by    VARCHAR(128) NOT NULL,
  updated_by    VARCHAR(128) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT csp_weekly_hours_nao_negativo CHECK (weekly_hours IS NULL OR weekly_hours >= 0),
  CONSTRAINT csp_active_ended_coerente
    CHECK ((active AND ended_at IS NULL) OR (NOT active AND ended_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_contracted_service_providers_service
  ON contracted_service_providers (service_id);
CREATE INDEX IF NOT EXISTS idx_contracted_service_providers_worker
  ON contracted_service_providers (worker_id);
-- Uma alocação ATIVA por (serviço, prestador) por vez — reassociar depois de dar de baixa cria
-- linha NOVA (histórico preservado), não reabre a antiga.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contracted_service_providers_active_pair
  ON contracted_service_providers (service_id, worker_id) WHERE active;

CREATE OR REPLACE FUNCTION fn_contracted_service_providers_country_from_service()
RETURNS TRIGGER AS $$
BEGIN
  -- Herda do SERVIÇO (⇒ do paciente), não do worker — decisão de desenho (lex C-e.1): o registro
  -- é satélite do CASO, e um prestador de outra jurisdição pode estar alocado a um caso local.
  IF NEW.country IS NULL THEN
    SELECT pcs.country INTO NEW.country FROM patient_contracted_services pcs WHERE pcs.id = NEW.service_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contracted_service_providers_country ON contracted_service_providers;
CREATE TRIGGER trg_contracted_service_providers_country
  BEFORE INSERT ON contracted_service_providers
  FOR EACH ROW EXECUTE FUNCTION fn_contracted_service_providers_country_from_service();

ALTER TABLE contracted_service_providers ALTER COLUMN country SET NOT NULL;

ALTER TABLE contracted_service_providers DROP CONSTRAINT IF EXISTS csp_country_check;
ALTER TABLE contracted_service_providers
  ADD CONSTRAINT csp_country_check CHECK (country IN ('AR', 'BR'));

COMMENT ON TABLE contracted_service_providers IS
  'Prestador(es) alocado(s) num serviço contratado (spec 013, lex C-e). Dado pessoal do '
  'prestador + sensível por associação (art. 10, dever de sigilo). country herdado do SERVIÇO '
  '(⇒ do paciente), não do worker — trigger fn_contracted_service_providers_country_from_service. '
  'Baixa = active=false + ended_at, nunca DELETE (C-e.2); weekly_hours NÃO é registro de jornada '
  '(C-e.3). Cascata do serviço — sai junto no purge do paciente (D248, transitivo).';
