output "name" {
  value = google_sql_database_instance.this.name
}

output "connection_name" {
  value       = google_sql_database_instance.this.connection_name
  description = "Conexão pra Cloud SQL Proxy: <project>:<region>:<instance>"
}

output "public_ip" {
  value = google_sql_database_instance.this.public_ip_address
}

output "self_link" {
  value = google_sql_database_instance.this.self_link
}
