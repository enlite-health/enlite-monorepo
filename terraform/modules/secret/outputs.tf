output "id" {
  value = google_secret_manager_secret.this.id
}

output "secret_id" {
  value = google_secret_manager_secret.this.secret_id
}

output "name" {
  value = google_secret_manager_secret.this.name
}
