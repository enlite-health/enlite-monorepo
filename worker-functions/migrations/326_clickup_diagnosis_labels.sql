-- 326 — `clickup_diagnosis_labels`: o mapa "Tipo de Patología" (ClickUp) → CID-11 (spec 016, F4)
--
-- ── POR QUE TABELA, NÃO `switch` EM TYPESCRIPT (D190) ───────────────────────────────────────
-- A spec (US-3) pedia o mapa num ARQUIVO de contrato. A D190 já tinha decidido, ANTES desta
-- fase, que "o mapeamento origem→canônico é TABELA, não switch — a MESMA escolha da migration
-- 287 (`device_type_aliases`), pelo mesmo motivo: trocar vocabulário sem deploy". Este arquivo
-- segue a D190, não a spec: molde IDÊNTICO ao de `device_type_aliases` (hoje
-- `307_device_types_catalog.sql` — a spec cita "287" porque essa era a numeração da migration
-- quando a D190 foi escrita; a tabela é a mesma, só o número do arquivo mudou desde então).
--
-- ── POR QUE GUARDA `concept_uri`, NÃO `concept_code` DIRETO ─────────────────────────────────
-- `patient_diagnoses` (migration 325) grava code/title/group/release RESOLVIDOS pela
-- `TerminologyPort`, nunca copiados de uma tabela paralela — é o que garante que o dado do
-- paciente sempre reflete o catálogo vigente (Contrato de arquitetura da spec 016: "só a
-- porta, o adaptador e a migration conhecem o vocabulário"). Se esta tabela guardasse
-- code/title direto, o mapeamento do ClickUp desalinharia do catálogo no dia em que o release
-- mudasse — exatamente o "artefato inerte com cara de rastreabilidade" que a D263 rejeitou para
-- `concept_parent_uri`. Por isso: só a URI (o identificador opaco, cláusula 1.2.2), e quem
-- resolve code/title/group/release é sempre `RecordPatientDiagnosis` → `TerminologyPort.getByUri`.
--
-- ── SEM FK para `terminology.icd_entities` (mesmo motivo da 325) ────────────────────────────
-- `terminology` e `public` têm posturas de segurança opostas (schema público-OMS vs. schema
-- PHI deny-by-default); uma FK cruzando essa fronteira acopla dois ciclos de vida que devem
-- evoluir independentes. A integridade é validada NA LEITURA pelo `RecordPatientDiagnosis`
-- (`concept_not_resolved` se a URI não existir mais no catálogo corrente).
--
-- ── LICENÇA 1.2.4 — este mapa é conteúdo NOSSO, não da OMS (mesma cláusula de `icd_synonyms`) ─
-- A OMS publica os códigos e títulos; QUAL rótulo do ClickUp cai em QUAL código é decisão
-- operacional da Enlite, documentada e versionada nesta tabela — nunca atribuível à OMS.
--
-- ── O QUE NÃO MAPEAR (D260/US-3) ─────────────────────────────────────────────────────────────
-- Rótulo sem linha aqui NUNCA é inventado. `ClickUpDiagnosisMapper` (infrastructure/clickup)
-- registra a ausência em `patient_source_label_rejections` (migration 304), reason='unmapped' —
-- reuso do padrão já existente para "rótulo cru que não bateu num destino conhecido", em vez de
-- criar uma segunda tabela de recusa para o mesmo conceito.
--
-- ── SEED: PROVISÓRIO, e isto está registrado de propósito ───────────────────────────────────
-- 🔴 Não existe, neste ambiente, um `contracts/clickup-fields.md` nem acesso à rota viva
-- `/list/901304883903/field` do ClickUp — logo os 10 rótulos vivos de "Tipo de Patología"
-- (US-3) não puderam ser lidos. As 2 linhas abaixo são as ÚNICAS que a F4 pôde confirmar contra
-- o catálogo REAL local (`terminology.icd_entities`, release 2026-01) e contra nomenclatura já
-- usada em código vivo desta base (`clinicalSpecialtyMap.ts`: "AT para Pacientes con TEA";
-- `patient-diagnoses-api.e2e.test.ts`: `6A02.Z` = "Trastorno del espectro autista..."). As 8
-- opções restantes ficam em LISTA no relatório da F4 — não inventadas.
--
-- Rollback: DROP TABLE clickup_diagnosis_labels; — nasce vazia nesta árvore, nenhum diagnóstico
-- de paciente depende dela (a dependência é o inverso: o mapper LÊ daqui antes de escrever em
-- `patient_diagnoses`, nunca o contrário).

CREATE TABLE IF NOT EXISTS clickup_diagnosis_labels (
  source       TEXT        NOT NULL DEFAULT 'clickup',
  label        TEXT        NOT NULL,
  -- URI OPACA do CID-11 (o que `TerminologyPort.getByUri` resolve) — nunca code/title/group
  -- direto (ver nota acima).
  concept_uri  TEXT        NOT NULL,
  -- Permite aposentar um mapeamento sem apagar histórico (molde `device_types.active`).
  active       BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT clickup_diagnosis_labels_pkey
    PRIMARY KEY (source, label),
  CONSTRAINT clickup_diagnosis_labels_label_not_blank
    CHECK (btrim(label) <> ''),
  CONSTRAINT clickup_diagnosis_labels_uri_not_blank
    CHECK (btrim(concept_uri) <> '')
);

CREATE INDEX IF NOT EXISTS idx_clickup_diagnosis_labels_uri
  ON clickup_diagnosis_labels (concept_uri);

COMMENT ON TABLE clickup_diagnosis_labels IS
  'ConceptMap: rótulo de "Tipo de Patología" (ClickUp) → concept_uri do CID-11. Tabela, não '
  'switch (D190, mesmo molde de device_type_aliases) — trocar/corrigir um mapeamento não pede '
  'deploy. Guarda só a URI (opaca): code/title/group/release são sempre resolvidos NA ESCRITA '
  'via TerminologyPort, nunca copiados daqui (Contrato de arquitetura, spec 016). CONTEÚDO '
  'NOSSO, não da OMS (licença 1.2.4) — mesma cláusula de terminology.icd_synonyms. Rótulo sem '
  'linha aqui fica em patient_source_label_rejections (reason=''unmapped''), nunca inventado.';
COMMENT ON COLUMN clickup_diagnosis_labels.label IS
  'Rótulo LITERAL da opção "Tipo de Patología" no ClickUp, grafia exata (ex.: "Trastorno", não '
  '"Transtorno" — contracts/clickup-fields.md). Chave natural junto com source.';
COMMENT ON COLUMN clickup_diagnosis_labels.concept_uri IS
  'URI opaca do CID-11 (identificador, cláusula 1.2.2). Resolvida via TerminologyPort.getByUri '
  'na escrita de patient_diagnoses — nunca lida como code/title direto desta tabela.';

-- ── Seed PROVISÓRIO (ver nota acima) ────────────────────────────────────────────────────────
-- As duas únicas entradas confirmadas contra o catálogo real (release 2026-01) neste ambiente.
-- `ON CONFLICT DO NOTHING`: re-rodar a migration não sobrescreve um mapeamento que a operação
-- já tenha corrigido manualmente.
INSERT INTO clickup_diagnosis_labels (source, label, concept_uri) VALUES
  ('clickup', 'Trastorno del Espectro Autista',
    'http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified'),
  ('clickup', 'Parálisis Cerebral',
    'http://id.who.int/icd/release/11/2026-01/mms/1426032265')
ON CONFLICT (source, label) DO NOTHING;

-- ── `patient_source_label_rejections.reason` ganha 'unmapped' (aditivo — amplia o CHECK) ────
-- Reuso do padrão existente (migration 304) para "rótulo cru que o destino não reconheceu",
-- em vez de uma segunda tabela de recusa para o mesmo conceito (D260: "o que não mapear fica
-- em LISTA" — esta é a LISTA durável).
ALTER TABLE patient_source_label_rejections
  DROP CONSTRAINT IF EXISTS patient_source_label_rejections_reason;
ALTER TABLE patient_source_label_rejections
  ADD CONSTRAINT patient_source_label_rejections_reason
    CHECK (reason IN ('ceiling', 'blank', 'duplicate', 'unmapped'));

-- ── `enlite_mcp_ro`: SEM revoke, e é deliberado ─────────────────────────────────────────────
-- Diferente de `patient_diagnoses` (325) e das tabelas do módulo `case` (D263), esta tabela NÃO
-- carrega dado de paciente — é o ConceptMap rótulo→URI, metadado de catálogo, mesma classe de
-- `device_types`/`device_type_aliases` (migration 307), que também não estão na lista
-- fail-closed de `scripts/create-mcp-ro-role.sql`. `ALTER DEFAULT PRIVILEGES ... REVOKE` (já
-- aplicado para as roles `enlite_app`/`postgres` nesse script) impede que ela nasça visível por
-- "default privilege" — o que falta para o conector claude.ai enxergá-la é rodar esse script de
-- novo (que já dá `GRANT SELECT ON ALL TABLES`, deliberadamente, para tabelas não sensíveis).
