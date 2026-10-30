# Sabotagem: papel de escrita no bucket de conhecimento.
resource "google_storage_bucket_iam_member" "sabotagem" {
  bucket = "enlite-agentes-conhecimento"
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:x@example.iam.gserviceaccount.com"
}
