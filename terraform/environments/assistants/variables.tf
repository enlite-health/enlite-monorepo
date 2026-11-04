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
  description = "Cloud Scheduler region (retention job)"
}

variable "assistants_service_url" {
  type        = string
  default     = ""
  description = "URL of the assistants-service Cloud Run. Empty on the 1st apply (the service is born on the 1st gcloud run deploy); filled in on the 2nd apply it enables the scheduler."
}

variable "deploy_sa_email" {
  type        = string
  description = "Email of the deploy service account (reads the owner secret and acts as the service SA)"
}
