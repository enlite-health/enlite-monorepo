# Sabotagem: concede acesso ao secret do banco enlite-ar-db.
resource "google_secret_manager_secret_iam_member" "sabotagem" {
  secret_id = "enlite-ar-db-password"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:x@example.iam.gserviceaccount.com"
}
