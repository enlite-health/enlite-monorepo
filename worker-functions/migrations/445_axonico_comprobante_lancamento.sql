-- 445 — Registro de tentativas de lançamento de comprovante no Axonico (change `integracao-axonico`,
-- F2 — a tabela que faz o dedupe local antes do dedupe remoto do próprio Axonico).
--
-- Por quê: a change `integracao-axonico` (F1, commit af04f31b) construiu o cliente HTTP
-- (`AxonicoApiClient`) e o mapa de tipo de serviço, mas nenhuma tentativa de envio de comprovante
-- ficava registrada no nosso lado. Sem essa tabela, o use case (F3, fora do escopo desta migration)
-- não tem como responder "esse `(patient_id, service_type, service_date)` já foi faturado com
-- sucesso?" sem bater na API do Axonico a cada checagem — e cada `PUT /api/comprobante` real GERA
-- FATURAMENTO (não há sandbox), então o dedupe local é o que evita reenvio acidental por retry de
-- rede, corrida duplicada de cron, ou reprocessamento manual.
--
-- Desenho: CADA TENTATIVA é uma linha nova, nunca um `UPDATE` de status (o repositório em F2 nunca
-- faz `ON CONFLICT DO UPDATE`) — a tabela é um REGISTRO DE TENTATIVAS, não um estado mutável por
-- tripla. Só uma tentativa `status='enviado'` pode existir por `(document_number, service_type,
-- service_date)` — o índice único parcial abaixo garante isso no banco, e é ELE que tem que poder
-- estourar (a violação da constraint é o que prova, em teste, que o dedupe é real). Tentativas
-- `duplicado`/`erro` podem se repetir livremente: uma corrida que falhou ontem e é reprocessada
-- hoje grava outra linha `erro`, sem conflito.
--
-- CORREÇÃO (18/09/2026, antes do merge — esta migration NUNCA rodou em produção): o desenho
-- original chaveava o dedupe por `patient_id`. Errado — o Axonico fatura por `historia_clinica`,
-- que é DERIVADA DO DNI (`findPatientByDni`, `IAxonicoApiClient.ts`), não do nosso `patient_id`.
-- Medido em produção: existem 2 cadastros (`patient_id` distintos) com o MESMO DNI real de 8
-- dígitos — cada um passava o dedupe local isoladamente, e os dois viravam `PUT /api/comprobante`
-- reais para a MESMA `historia_clinica`, faturando duas vezes. `patients.document_number` não tem
-- UNIQUE (só `idx_patients_document`, não-único, `migrations/037_create_patients.sql:77`) — a
-- chave que protege contra reenvio tem que ser a que o PARCEIRO usa para faturar, não a nossa PK
-- interna. Por isso `document_number` vira coluna própria desta tabela (não só leitura via join
-- com `patients`, que mudaria sob a mesma corrida) e entra no índice único no lugar de
-- `patient_id`. `patient_id` continua na tabela — histórico/rastreabilidade de qual cadastro
-- nosso gerou a tentativa —, só sai do índice de dedupe.
--
-- Sem PII do Axonico: a tabela guarda `patient_id` (nosso UUID, `patients.id`) e agora também
-- `document_number` — não é exposição nova: `patients.document_number` já vive em claro no MESMO
-- banco (`migrations/037_create_patients.sql:20`), sem encriptação KMS (ao contrário da PII de
-- `workers`). O dado sensível de terceiro que continua de fora é `historia_clinica`/
-- `nro_cobertura`/nome — esses vivem só na chamada HTTP (D367, ver `IAxonicoApiClient.ts`), nunca
-- persistidos. `numero_comprobante`/`cod_autorizacion` são identificadores do NOSSO lançamento no
-- Axonico (não dado clínico), gravados só quando `status='enviado'` — daí serem NULLABLE.
--
-- `hours` é INTEGER, nunca NUMERIC: hora quebrada (D366, `IAxonicoApiClient.ts` —
-- `SubmitComprobanteParams.cantidad`) nunca chega até aqui; a garantia de "sempre inteiro" é de
-- SCHEMA, não só de validação de aplicação.
--
-- Mesmo molde de 439/441/442/443: `country` texto com default, GRANT explícito por tabela (sem
-- ALTER DEFAULT PRIVILEGES), PK `BIGSERIAL`.
--
-- Rollback (par desta migration): NÃO fica em `migrations/` com número — ver
-- `migrations/pending/ROLLBACK_axonico_comprobante_lancamento.sql` e seu cabeçalho para o motivo
-- (o runner aplicaria automaticamente na próxima corrida se o arquivo tivesse número).

BEGIN;

CREATE TABLE IF NOT EXISTS axonico_comprobante_lancamento (
  id                  BIGSERIAL    PRIMARY KEY,
  -- NULLABLE de propósito (Gabriel, 19/09/2026): o lançamento é feito pelo `document_number` que
  -- vem do Ana Care, sem `patientId` de entrada e sem consultar `patients` — os pacientes da tela
  -- de conferência de horas NÃO são vinculados aos nossos ainda (`patients.ana_care_id` é NULL nos
  -- 388 de prd, `patient_identity_links` tem 0 linhas). A coluna fica para quando o vínculo existir;
  -- até lá grava NULL. NOT NULL aqui faria todo insert real estourar.
  patient_id          UUID         REFERENCES patients(id),
  document_number     TEXT         NOT NULL,
  service_type        TEXT         NOT NULL CHECK (service_type IN ('AT')),
  service_date        DATE         NOT NULL,
  hours               INTEGER      NOT NULL CHECK (hours > 0),
  numero_comprobante  TEXT,
  cod_autorizacion    TEXT,
  status              TEXT         NOT NULL CHECK (status IN ('enviado', 'duplicado', 'erro')),
  error_message       TEXT,
  country             TEXT         NOT NULL DEFAULT 'AR',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_axonico_lancamento_error_message
    CHECK ((status = 'erro' AND error_message IS NOT NULL) OR (status <> 'erro' AND error_message IS NULL))
);

-- Dedupe: no máximo UMA tentativa `enviado` por `(document_number, service_type, service_date)` —
-- a chave que o PARCEIRO usa para faturar (historia_clinica é derivada do DNI), não `patient_id`
-- (dois cadastros nossos podem compartilhar o mesmo DNI — ver correção no cabeçalho). `duplicado`/
-- `erro` ficam FORA do índice (parcial) porque a tabela é registro de tentativas — só a tentativa
-- que efetivamente faturou precisa ser única.
CREATE UNIQUE INDEX IF NOT EXISTS uq_axonico_lancamento_dedupe
  ON axonico_comprobante_lancamento (document_number, service_type, service_date)
  WHERE status = 'enviado';

-- Consulta por paciente/período (tela de histórico de lançamentos, fora do escopo desta F2).
CREATE INDEX IF NOT EXISTS idx_axonico_lancamento_patient_date
  ON axonico_comprobante_lancamento (patient_id, service_date);

COMMENT ON TABLE axonico_comprobante_lancamento IS
  'Registro de TENTATIVAS de lançamento de comprovante no Axonico (change integracao-axonico, F2). '
  'Cada tentativa é uma linha nova — o repositório nunca faz UPDATE de status. Dedupe por '
  'document_number (a chave que o Axonico fatura, via historia_clinica), não por patient_id — dois '
  'cadastros nossos podem compartilhar o mesmo DNI. document_number já vive em claro em '
  'patients.document_number; não é exposição nova. Nunca historia_clinica/nro_cobertura/nome.';

COMMENT ON COLUMN axonico_comprobante_lancamento.document_number IS
  'DNI normalizado do paciente (patients.document_number), gravado no momento da tentativa — chave '
  'do dedupe (uq_axonico_lancamento_dedupe), porque o Axonico fatura por historia_clinica, que É '
  'DERIVADA DO DNI, nunca do nosso patient_id. patients.document_number não tem UNIQUE '
  '(idx_patients_document é não-único) — dois patient_id podem ter o mesmo DNI, e só a chave do '
  'PARCEIRO protege contra faturamento duplicado nesse caso.';

COMMENT ON COLUMN axonico_comprobante_lancamento.hours IS
  'Quantidade faturada — sempre INTEGER (D366: 1 hora = cantidad 1, hora quebrada nunca chega '
  'aqui). A garantia é de schema, não só de validação de aplicação.';

COMMENT ON COLUMN axonico_comprobante_lancamento.status IS
  'enviado = PUT /api/comprobante confirmado (numero_comprobante/cod_autorizacion presentes); '
  'duplicado = dedupe (local ou do Axonico) recusou o envio; erro = falha na tentativa '
  '(error_message obrigatório).';

COMMENT ON COLUMN axonico_comprobante_lancamento.error_message IS
  'Obrigatório quando status=erro, proibido nos demais status — CHECK '
  'chk_axonico_lancamento_error_message amarra os dois sentidos.';

COMMENT ON INDEX uq_axonico_lancamento_dedupe IS
  'Dedupe local: no máximo uma tentativa enviado por (document_number, service_type, service_date) '
  '— a chave que o Axonico fatura, não patient_id (dois cadastros podem compartilhar o mesmo DNI). '
  'Parcial (WHERE status = ''enviado'') — duplicado/erro podem repetir, a tabela é registro de '
  'tentativas, não estado mutável por tripla.';

-- GRANT explícito por tabela (convenção do repo — sem ALTER DEFAULT PRIVILEGES, molde 439/441/442/443).
GRANT SELECT, INSERT, UPDATE ON axonico_comprobante_lancamento TO app_runtime, app_system;
GRANT USAGE, SELECT ON SEQUENCE axonico_comprobante_lancamento_id_seq TO app_runtime, app_system;

COMMIT;
