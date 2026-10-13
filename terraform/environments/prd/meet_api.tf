# Spec 050: API do Google Meet. O backend le o inicio e o fim das reunioes de admissao.
# Habilitada A MAO em 13/10/2026 (gcloud services enable, tf-admin); precisa de
# `terraform import` ANTES do primeiro apply (ver corpo do PR).
resource "google_project_service" "meet" {
  project            = var.project_id
  service            = "meet.googleapis.com"
  disable_on_destroy = false
}
