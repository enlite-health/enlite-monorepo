# Retention scheduler (spec 080, contract ddl-gestoras.sql.md sec. 6).
# Molde: prd/events.tf:88-91 (oidc_token) e :121 (job).
# count = 0 on the 1st apply: Cloud Run is born on the 1st `gcloud run deploy`; only on the 2nd apply
# (assistants_service_url filled in) does the job come to exist.
resource "google_cloud_scheduler_job" "assistants_retention" {
  count = var.assistants_service_url == "" ? 0 : 1

  project          = var.project_id
  region           = var.scheduler_region
  name             = "assistants-retention"
  schedule         = "0 3 * * *"
  time_zone        = "America/Argentina/Buenos_Aires"
  attempt_deadline = "300s"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "${var.assistants_service_url}/internal/retention"
    body        = base64encode("{}")
    headers = {
      "Content-Type" = "application/json"
    }
    oidc_token {
      service_account_email = module.assistants_scheduler_sa.email
      audience              = var.assistants_service_url
    }
  }
}
