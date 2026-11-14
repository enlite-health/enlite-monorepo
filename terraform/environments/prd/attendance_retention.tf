# Spec 077 F5 (FR-56/57): retencao de 90 dias das coordenadas do attendance em prd.
# Job diario attendance-retention (Cloud Run Job, mesma imagem do attendance-service) chama
# attendance.purge_old_coordinates(interval '90 days') pelo script dist/scripts/retention.js (PR-ATT-07) e loga 1 linha
# JSON {"event":"attendance_retention","purged":N,"pending_over_90d":M,"deletion_requests_stale":K}.
# Banco: connector do Cloud SQL com login IAM por IP publico (pg-pool.factory.ts do attendance), sem socket /cloudsql.
# Imagem: a do attendance-service NO MOMENTO da criacao (data source); depois o HCL ignora a imagem (FR-56; padrao de
# terraform/modules/cloud-run/main.tf, ignore_changes da imagem): quem a renova e o workflow do attendance.

data "google_cloud_run_v2_service" "attendance" {
  project  = var.project_id
  location = "southamerica-west1"
  name     = "attendance-service"
}

resource "google_cloud_run_v2_job" "attendance_retention" {
  project  = var.project_id
  name     = "attendance-retention"
  location = "southamerica-west1"

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account = module.sa_attendance_retention.email
      max_retries     = 1
      timeout         = "600s"

      containers {
        image   = data.google_cloud_run_v2_service.attendance.template[0].containers[0].image
        command = ["node"]
        args    = ["dist/scripts/retention.js"]

        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "INSTANCE_CONNECTION_NAME"
          value = module.sql_enlite_ar_db.connection_name
        }
        env {
          name  = "DB_NAME"
          value = "enlite_ar"
        }
        env {
          name  = "DB_USER"
          value = google_sql_user.attendance_retention_iam.name
        }
        env {
          name  = "DELETION_STALE_HOURS"
          value = "72"
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }
}

# Disparo diario 03:00 de Buenos Aires (FR-56). Molde: o e2e-prod-smoke-daily vivo (POST no jobs/<job>:run da API v2 com
# oauth_token). Quem chama e a propria SA do job, que so tem run.invoker NESTE job (run.invoker inclui run.jobs.run).
resource "google_cloud_run_v2_job_iam_member" "attendance_retention_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_job.attendance_retention.location
  name     = google_cloud_run_v2_job.attendance_retention.name
  role     = "roles/run.invoker"
  member   = module.sa_attendance_retention.member
}

resource "google_cloud_scheduler_job" "attendance_retention" {
  project          = var.project_id
  region           = var.scheduler_region
  name             = "attendance-retention"
  description      = "Spec 077 F5: retencao de 90 dias das coordenadas do attendance (Cloud Run Job attendance-retention). Idempotente."
  schedule         = "0 3 * * *"
  time_zone        = "America/Argentina/Buenos_Aires"
  attempt_deadline = "180s"

  retry_config {
    retry_count          = 0
    max_backoff_duration = "3600s"
    max_doublings        = 5
    max_retry_duration   = "0s"
    min_backoff_duration = "5s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${google_cloud_run_v2_job.attendance_retention.location}/jobs/${google_cloud_run_v2_job.attendance_retention.name}:run"

    oauth_token {
      service_account_email = module.sa_attendance_retention.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_cloud_run_v2_job_iam_member.attendance_retention_invoker]
}
