-- 513 — Reserva sem evento no Google não segura o horário (spec 050, F9, R-34/R-35).
--
-- Novo valor de `admission_appointments.status`: `calendar_failed` = a linha foi reservada, o Google não criou o evento (ou devolveu
-- evento sem id/link do Meet) e a reserva foi desfeita. Fica fora da trava de horário porque o índice da 512
-- (`uq_admission_appointments_host_slot_booked`) só vale para `status = 'booked'`: o horário volta a ser reservável na hora.
--
-- Aditiva: só AMPLIA o conjunto aceito (todo dado que passava na CHECK antiga passa na nova). Nenhuma linha existente muda.
-- Sem BEGIN/COMMIT próprio: o runner já cuida da atomicidade/registro (a 509 abriu transação própria e isso gera aviso no boot).
-- Idempotente (2×): DROP CONSTRAINT IF EXISTS + ADD.
-- VOLTA: reverter só o código deixa o valor novo na CHECK (seguro). Remover o valor exige antes zerar as linhas `calendar_failed`.

ALTER TABLE admission_appointments DROP CONSTRAINT IF EXISTS admission_appointments_status_check;
ALTER TABLE admission_appointments
  ADD CONSTRAINT admission_appointments_status_check
  CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show', 'calendar_failed'));
