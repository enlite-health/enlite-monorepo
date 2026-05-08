output "email" {
  value       = google_service_account.this.email
  description = "Email completo da SA"
}

output "name" {
  value       = google_service_account.this.name
  description = "Resource name da SA"
}

output "member" {
  value       = "serviceAccount:${google_service_account.this.email}"
  description = "Formato 'serviceAccount:<email>' pra usar em IAM bindings"
}
