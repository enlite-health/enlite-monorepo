output "name" {
  value       = google_storage_bucket.this.name
  description = "Nome do bucket criado"
}

output "url" {
  value       = google_storage_bucket.this.url
  description = "URL gs:// do bucket"
}

output "self_link" {
  value       = google_storage_bucket.this.self_link
  description = "Self link do bucket"
}
