variable "repository_id" {
  type        = string
  description = "Nome do repositório (ex: worker-functions)"
}

variable "location" {
  type        = string
  description = "Region do repositório"
}

variable "format" {
  type        = string
  default     = "DOCKER"
  description = "Format: DOCKER, MAVEN, NPM, PYTHON, etc."
}

variable "mode" {
  type        = string
  default     = "STANDARD_REPOSITORY"
  description = "Mode: STANDARD_REPOSITORY, REMOTE_REPOSITORY, VIRTUAL_REPOSITORY"
}

variable "description" {
  type        = string
  default     = null
  description = "Descrição opcional do repositório"
}

variable "project_id" {
  type        = string
  description = "GCP project ID"
}
