variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "Default GCP region for regional resources"
}

variable "scheduler_region" {
  type        = string
  description = "Region do Cloud Scheduler (job de retencao)"
}

variable "gestoras_service_url" {
  type        = string
  default     = ""
  description = "URL do Cloud Run gestoras-service. Vazia no 1o apply (o servico nasce no 1o gcloud run deploy); preenchida no 2o apply habilita o scheduler."
}

variable "deploy_sa_email" {
  type        = string
  description = "E-mail da service account de deploy (acessa o secret do dono e age como a SA do servico)"
}
