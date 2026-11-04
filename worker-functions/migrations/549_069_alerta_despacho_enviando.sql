-- 549 · spec 069 (QA caça, D2c): o despacho do alerta "Sin cubrir" ganha o estado 'SENDING' (e-mail REIVINDICADO por uma execução).
--
-- Por quê: duas execuções concorrentes da rotina (retry do Scheduler + disparo manual) liam o MESMO 'PENDING' e mandavam o e-mail
-- duas vezes. Agora a execução reivindica a linha (UPDATE … SET email_status='SENDING' … WHERE email_status IN ('PENDING','FAILED')
-- OR (SENDING há mais de 15 min) RETURNING) ANTES de enviar; só quem reivindicou envia. A 548 já está na stage, por isso é migration
-- nova (nunca editar a aplicada). 'SENDING' parado há > 15 min (execução que morreu entre reivindicar e marcar) volta a ser tentável.
-- A CHECK iuad_error_pair não muda: 'SENDING' tem email_error_code NULL (a reivindicação o zera).
ALTER TABLE itinerary_uncovered_alert_dispatch DROP CONSTRAINT IF EXISTS itinerary_uncovered_alert_dispatch_email_status_check;
ALTER TABLE itinerary_uncovered_alert_dispatch
  ADD CONSTRAINT itinerary_uncovered_alert_dispatch_email_status_check
  CHECK (email_status IN ('PENDING','SENDING','SENT','FAILED','SKIPPED_TEST','SKIPPED_NO_KEY','NO_ADDRESS'));
