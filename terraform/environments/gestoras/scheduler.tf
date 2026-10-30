# Scheduler da retencao (spec 080, contrato ddl-gestoras.sql.md sec. 6).
# Molde: prd/events.tf:88-91 (oidc_token) e :121 (job).
# count = 0 no 1o apply: o Cloud Run nasce no 1o `gcloud run deploy`; so no 2o apply
# (gestoras_service_url preenchida) o job passa a existir.
resource "google_cloud_scheduler_job" "gestoras_retencao" {
  count = var.gestoras_service_url == "" ? 0 : 1

  project          = var.project_id
  region           = var.scheduler_region
  name             = "gestoras-retencao"
  schedule         = "0 3 * * *"
  time_zone        = "America/Argentina/Buenos_Aires"
  attempt_deadline = "300s"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "${var.gestoras_service_url}/internal/retencao"
    body        = base64encode("{}")
    headers = {
      "Content-Type" = "application/json"
    }
    oidc_token {
      service_account_email = module.gestoras_scheduler_sa.email
      audience              = var.gestoras_service_url
    }
  }
}
