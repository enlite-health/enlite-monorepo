resource "google_cloud_run_v2_service" "this" {
  project  = var.project_id
  name     = var.name
  location = var.location
  ingress  = var.ingress

  template {
    service_account = var.service_account_email

    scaling {
      min_instance_count = var.min_scale
      max_instance_count = var.max_scale
    }

    annotations = {
      "run.googleapis.com/startup-cpu-boost" = tostring(var.startup_cpu_boost)
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = var.cpu_limit
          memory = var.memory_limit
        }
        cpu_idle          = var.cpu_throttling
        startup_cpu_boost = var.startup_cpu_boost
      }

      dynamic "volume_mounts" {
        for_each = length(var.cloud_sql_instances) > 0 ? [1] : []
        content {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }

    dynamic "volumes" {
      for_each = length(var.cloud_sql_instances) > 0 ? [1] : []
      content {
        name = "cloudsql"
        cloud_sql_instance {
          instances = var.cloud_sql_instances
        }
      }
    }
  }

  # Env vars e imagem ficam fora do TF — gerenciadas por gcloud run deploy
  # ou pelo workflow CI/CD. Isso evita drift contínuo entre o que o pipeline
  # escreve e o que está no HCL.
  #
  # `template[0].labels` entrou em 13/08/2026 pelo mesmo motivo: o CI carimba
  # `commit-sha` e `managed-by=github-actions` em cada deploy, e sem ignorá-los
  # o terraform pedia para APAGAR os dois — jogando fora a única marca de qual
  # commit está no ar naquele serviço. Rastreabilidade > simetria de HCL.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].annotations,
      template[0].labels,
      client,
      client_version,
    ]
  }
}
