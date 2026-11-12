# Spec 082 (painel de custos), DF-10 / T055 — trilha do log `ai_usage`.
#
# Cada chamada de IA do backend emite uma linha JSON `ai_usage` (event, service, setor, funcao, model, tokens_in, tokens_out;
# NUNCA texto, RF-12). O sink abaixo exporta só essas linhas para o dataset `ai_usage_logs`, na MESMA localização US do
# `billing_export` (dataset em locais diferentes não se cruza numa consulta, DF-10).
#
# Tabela criada pelo próprio sink na primeira linha: com `use_partitioned_tables` o nome vem do log name com `.` e `/` virando `_`
# (https://cloud.google.com/logging/docs/export/bigquery#table-organization) — para stdout do Cloud Run, `run_googleapis_com_stdout`.
# Até a primeira linha chegar a tabela NÃO existe: o leitor do painel trata isso como "sem dados".
resource "google_bigquery_dataset" "ai_usage_logs" {
  project    = var.project_id
  dataset_id = "ai_usage_logs"
  location   = "US"
}

resource "google_logging_project_sink" "ai_usage_to_bq" {
  project = var.project_id
  name    = "ai_usage_to_bq"

  destination = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.ai_usage_logs.dataset_id}"
  filter      = "resource.type=\"cloud_run_revision\" AND jsonPayload.event=\"ai_usage\""

  bigquery_options {
    use_partitioned_tables = true
  }

  # Identidade de escrita própria do sink (não a compartilhada do projeto): o grant abaixo vale só para ele.
  unique_writer_identity = true
}

# O sink só consegue gravar depois deste grant (privilégio mínimo: dataEditor, só neste dataset).
resource "google_bigquery_dataset_iam_member" "ai_usage_sink_writer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.ai_usage_logs.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.ai_usage_to_bq.writer_identity
}

# Leitura do backend (painel de custos, DF-8): só este dataset; o jobUser já existe em billing_export.tf.
resource "google_bigquery_dataset_iam_member" "ai_usage_backend_viewer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.ai_usage_logs.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = module.sa_enlite_functions.member
}
