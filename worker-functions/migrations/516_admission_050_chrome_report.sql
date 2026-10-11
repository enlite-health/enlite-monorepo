-- 516 — Relatório do Chrome por operadora (spec 050, F15: R-1, R-2, R-3).
--
-- (A) `admission_chrome_reports`: UMA linha por responsável (e-mail do roster) com o estado da extensão do Tactiq no Chrome gerenciado.
--     `state` = o último veredito do job (`sem_relatorio` | `ausente` | `desativada` | `instalada`); `report_at` = `relatorio_de`
--     (o `lastStatusReportTime` que o sustentou). `conclusive_state` = o último estado que NÃO foi `sem_relatorio`: é contra ele que se
--     detecta TRANSIÇÃO (1 evento + 1 aviso por transição); `sem_relatorio` não revoga nem libera (R-2) e não conta como transição.
--     NULL em `conclusive_state` = "o job nunca viu veredito conclusivo desta pessoa". NULL em `report_at` = "sem relatório utilizável".
--     Sem token, sem id de perfil/dispositivo, sem nome: só e-mail (chave do roster), estado e datas. Não concede aptidão a ninguém.
-- (B) `admission_events`: a CHECK 504 só admitia evento sem reunião para `tactiq_link.%`; passa a admitir também `tactiq_extension.%`
--     (`installed` | `missing` | `disabled`, com a data do relatório em `ref`).
-- (C) Tipo de notificação `ADMISSION_TACTIQ_EXTENSION_CHANGED` (aviso no sino por transição).
--
-- Sem BEGIN/COMMIT próprio (o runner envolve). Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_516_admission_050_chrome_report.sql

CREATE TABLE IF NOT EXISTS admission_chrome_reports (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  host_email        TEXT         NOT NULL,
  state             TEXT         NOT NULL CHECK (state IN ('sem_relatorio', 'ausente', 'desativada', 'instalada')),
  report_at         TIMESTAMPTZ  NULL,
  conclusive_state  TEXT         NULL CHECK (conclusive_state IN ('ausente', 'desativada', 'instalada')),
  state_changed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  checked_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_chrome_reports_host_email ON admission_chrome_reports (lower(host_email));

-- ALTER DEFAULT PRIVILEGES do banco já concede tudo ao criar a tabela: REVOGA e concede só o que o desenho quer (molde 505).
-- O runtime lê (o painel/trava de F16 vai ler); só o sistema (o job) escreve. Linha de estado não se apaga.
REVOKE ALL ON admission_chrome_reports FROM app_runtime, app_system;
GRANT SELECT ON admission_chrome_reports TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON admission_chrome_reports TO app_system;

COMMENT ON TABLE admission_chrome_reports IS
  'Estado da extensão do Tactiq por responsável, lido do relatório do Chrome (spec 050 F15). Não concede aptidão: instalada NÃO libera ninguém. Só e-mail do roster, estado e datas.';

ALTER TABLE admission_events DROP CONSTRAINT IF EXISTS admission_events_sem_reuniao_so_vinculo;
ALTER TABLE admission_events ADD CONSTRAINT admission_events_sem_reuniao_so_vinculo CHECK (
  appointment_id IS NOT NULL
  OR ((kind LIKE 'tactiq\_link.%' OR kind LIKE 'tactiq\_extension.%') AND host_email IS NOT NULL));

INSERT INTO notification_types (code, description) VALUES
  ('ADMISSION_TACTIQ_EXTENSION_CHANGED',
   'Aviso automático: o relatório do Chrome mudou o estado da extensão do Tactiq da operadora (instalada, ausente ou desativada)')
ON CONFLICT (code) DO NOTHING;

