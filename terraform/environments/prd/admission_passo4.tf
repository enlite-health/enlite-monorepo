# ---------------------------------------------------------------------------
# Spec 050 (F30, 4º passo) — agendador de 1 minuto da admissão e o alerta de silêncio dele (R-46)
# ---------------------------------------------------------------------------
# ⚠️ NÃO APLICADO: falta o "vai" do Gabriel (apply é ato dele, depois do merge, com o `plan` colado). Só criação, nenhum import.
# Sem o apply, o job novo (`POST /api/internal/jobs/admission-live`) nunca é chamado: o merge não muda nada em produção por este arquivo.
#
# Os dois recursos entram nos MESMOS `for_each` de `admission.tf` (google_cloud_scheduler_job.admission) e de
# `admission_alerts_passo2.tf` (google_logging_metric.admission_silence e google_monitoring_alert_policy.admission_silence),
# via merge: nenhum bloco de recurso é copiado. Recursos novos: 3 (1 agendador, 1 métrica de log, 1 política de alerta).
#
# Custo (spec §19.4): Cloud Scheduler US$ 0,10 por job por mês (+US$ 0,10/mês); 43.200 execuções por mês no Cloud Run,
# menos de US$ 1 por mês no total. Métrica de log e alerta: zero nesta escala.
#
# Rollback: antes do apply, `git revert`; depois do apply, `terraform destroy -target` dos 3 endereços:
#   google_cloud_scheduler_job.admission["admission-live"]
#   google_logging_metric.admission_silence["live_run_done"]
#   google_monitoring_alert_policy.admission_silence["live_run_done"]
# Ou, para só parar o job sem destruir: `gcloud scheduler jobs pause admission-live` (ato do Gabriel).
#
# Nomes conferidos 1:1 com o código: rota registrada em admissionLiveRoutes.ts (`/jobs/admission-live`
# sob `/api/internal`) e log `admission.live.run_done` emitido por AdmissionLiveJob.ts.
locals {
  admission_jobs_passo4 = {
    # A cada minuto. `retry_count = 0`: o minuto seguinte já é a nova tentativa (repetir só sobreporia execuções).
    # `attempt_deadline` fica nos 300 s de `admission.tf` (a importação na hora pode passar de 1 min).
    admission-live = {
      schedule    = "* * * * *"
      path        = "/api/internal/jobs/admission-live"
      retry_count = 0
    }
  }

  admission_silence_alerts_passo4 = {
    live_run_done = {
      message = "admission.live.run_done"
      window  = 600 # roda a cada minuto: 10 min = 10 execuções perdidas
      enabled = true
      what    = "Nenhum `admission.live.run_done` em 10 min: o job de 1 minuto da admissão não está rodando (job `admission-live`)."
    }
  }
}
