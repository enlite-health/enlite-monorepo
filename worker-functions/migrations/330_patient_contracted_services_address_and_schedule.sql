-- 330 — `patient_contracted_services.address_id` + `.schedule`: o serviço contratado passa a
-- apontar para UM endereço do paciente e a carregar o horário do encuadre.
--
-- Decisão do Gabriel (05/09): "UM serviço é 1 endereço"; "horários vão para o encuadre, mas o
-- operador pode criar uma vacante sem ter horário ainda". Regra viva desde a ata de 22/07
-- (REGRA-07: vaga = paciente × endereço × horário) e o RISCO-11 de 02/09 (a vaga chegou à demo sem
-- o endereço do paciente — o Marcel ditou de memória).
--
-- ── O que esta migration conserta ───────────────────────────────────────────
-- `ActivatePatientUseCase` gerava `serviços × endereços` (produto cartesiano): 2 serviços × 2
-- endereços = 4 vagas, 2 delas no lugar errado ("Cuidador" na escola, "AT" em casa). Sem um
-- ponteiro do serviço para o endereço o sistema NÃO TEM COMO saber qual é qual — `care_location`
-- (HOME/SCHOOL/…) é rótulo, não vínculo. A partir daqui: 1 serviço → 1 vaga, no endereço apontado.
--
-- ── Ponteiro, não cópia ──────────────────────────────────────────────────────
-- Nenhum campo de endereço é duplicado: `address_id` referencia `patient_addresses(id)` — o mesmo
-- desenho de `job_postings.patient_address_id`. A FK é COMPOSTA `(address_id, patient_id)` →
-- `patient_addresses(id, patient_id)`: o banco garante que o endereço É do mesmo paciente
-- (`vacancyCrudHelpers` faz essa checagem em código para a vaga; aqui é controle, não instrução).
-- `MATCH SIMPLE` (default): `address_id NULL` não é checado — serviço sem endereço continua válido
-- de gravar (é o checklist quem acusa, código SERVICE_ADDRESS; `PatientCompleteness.ts`).
-- Sem `ON DELETE`: endereço com serviço apontando NÃO pode ser apagado (o sync do ClickUp arquiva
-- em vez de apagar quando há referência — `PatientRelatedWriter.replacePatientAddresses`, que a
-- partir deste commit trata serviço como já tratava vaga). Purge do paciente (D248) cai por
-- CASCADE de `patient_id` nas duas tabelas dentro do mesmo statement — NO ACTION é conferido no
-- fim, com as duas linhas já removidas.
--
-- ── `schedule` JSONB, formato do editor ──────────────────────────────────────
-- Mesmo formato persistido em `job_postings.schedule` pelo form admin (`scheduleToJsonb`):
-- `[{ dayOfWeek: 0-6, startTime: 'HH:MM', endTime: 'HH:MM' }]`. NULL = "ainda não tem horário"
-- (estado legítimo: a vaga nasce sem `schedule` e o operador preenche nela, como hoje —
-- `OPERATIONAL_EDITABLE_FIELDS`). Na ativação o array é copiado tal qual para a vaga nascida
-- deste serviço; `normalizeSchedule` já lê essa forma.
--
-- Rollback: ALTER TABLE patient_contracted_services DROP CONSTRAINT pcs_address_same_patient_fk,
--           DROP CONSTRAINT pcs_schedule_is_array, DROP COLUMN address_id, DROP COLUMN schedule;
--           ALTER TABLE patient_addresses DROP CONSTRAINT patient_addresses_id_patient_uq;
-- Aditiva e 2× idempotente (IF NOT EXISTS / DROP IF EXISTS antes de cada ADD CONSTRAINT).

-- A FK composta precisa de uma chave única do lado referenciado com as MESMAS colunas.
ALTER TABLE patient_addresses DROP CONSTRAINT IF EXISTS patient_addresses_id_patient_uq;
ALTER TABLE patient_addresses
  ADD CONSTRAINT patient_addresses_id_patient_uq UNIQUE (id, patient_id);

ALTER TABLE patient_contracted_services
  ADD COLUMN IF NOT EXISTS address_id UUID NULL,
  ADD COLUMN IF NOT EXISTS schedule   JSONB NULL;

ALTER TABLE patient_contracted_services DROP CONSTRAINT IF EXISTS pcs_address_same_patient_fk;
ALTER TABLE patient_contracted_services
  ADD CONSTRAINT pcs_address_same_patient_fk
  FOREIGN KEY (address_id, patient_id) REFERENCES patient_addresses (id, patient_id);

ALTER TABLE patient_contracted_services DROP CONSTRAINT IF EXISTS pcs_schedule_is_array;
ALTER TABLE patient_contracted_services
  ADD CONSTRAINT pcs_schedule_is_array
  CHECK (schedule IS NULL OR jsonb_typeof(schedule) = 'array');

CREATE INDEX IF NOT EXISTS idx_pcs_address_id ON patient_contracted_services (address_id)
  WHERE address_id IS NOT NULL;

COMMENT ON COLUMN patient_contracted_services.address_id IS
  'Endereço do paciente onde ESTE serviço é prestado (ponteiro para patient_addresses; decisão do '
  'Gabriel 05/09: um serviço = um endereço). FK composta com patient_id garante que o endereço é do '
  'mesmo paciente. NULL = ainda não vinculado (o checklist acusa SERVICE_ADDRESS e a ativação '
  'bloqueia — nunca mais o produto cartesiano serviços × endereços).';

COMMENT ON COLUMN patient_contracted_services.schedule IS
  'Horário do encuadre, formato do editor (array [{dayOfWeek, startTime, endTime}] — o mesmo que '
  'job_postings.schedule persiste via scheduleToJsonb). NULL = ainda sem horário; a vaga nasce sem '
  'schedule e o operador preenche nela. Na ativação é copiado para a vaga nascida deste serviço.';
