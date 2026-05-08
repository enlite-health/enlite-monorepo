resource "google_secret_manager_secret" "this" {
  project   = var.project_id
  secret_id = var.secret_id

  replication {
    dynamic "auto" {
      for_each = length(var.replication_locations) == 0 ? [1] : []
      content {}
    }

    dynamic "user_managed" {
      for_each = length(var.replication_locations) > 0 ? [1] : []
      content {
        dynamic "replicas" {
          for_each = var.replication_locations
          content {
            location = replicas.value
          }
        }
      }
    }
  }
}
