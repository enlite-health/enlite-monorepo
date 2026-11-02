# Spec 082 (painel de custos), DF-8 / DF-9 / DF-12.
#
# Dataset de destino do export do Cloud Billing. Criado à mão em 02/11/2026 no console (spec 082, DF-12), multi-região US,
# e hoje vazio: o Google cria as tabelas do export dentro dele. Entra no state por `import` (executa só no apply).
# `access` NÃO é declarado de propósito: o atributo é Optional+Computed, então o Terraform não remove as entradas que o
# console criou (inclusive a do escritor do export do Billing). Sem `default_table_expiration_ms` (histórico de custo não expira).
resource "google_bigquery_dataset" "billing_export" {
  project    = var.project_id
  dataset_id = "billing_export"
  location   = "US"
}

import {
  to = google_bigquery_dataset.billing_export
  id = "projects/enlite-prd/datasets/billing_export"
}

# Privilégio mínimo do backend (DF-8): leitura SÓ neste dataset + permissão de rodar job de consulta no projeto.
resource "google_bigquery_dataset_iam_member" "billing_export_backend_viewer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.billing_export.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = module.sa_enlite_functions.member
}

resource "google_project_iam_member" "backend_bigquery_job_user" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = module.sa_enlite_functions.member
}
