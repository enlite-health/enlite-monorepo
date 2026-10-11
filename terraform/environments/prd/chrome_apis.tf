# Spec 050 (F18) — APIs do Chrome para o relatório de extensões da admissão. NÃO APLICADO: falta o "vai" do Gabriel.
# Custo: zero (as duas APIs não têm preço por chamada; só cota). Rollback: `terraform destroy -target` de cada uma.
resource "google_project_service" "chrome_management" {
  project            = var.project_id
  service            = "chromemanagement.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "chrome_policy" {
  project            = var.project_id
  service            = "chromepolicy.googleapis.com"
  disable_on_destroy = false
}
