output "name" {
  value       = google_artifact_registry_repository.this.name
  description = "Nome completo do repositório"
}

output "registry_uri" {
  value       = "${var.location}-docker.pkg.dev/${var.project_id}/${var.repository_id}"
  description = "URI do registry para uso em pulls/pushes Docker"
}
