variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "account_id" {
  type        = string
  description = "ID da SA (parte antes do @)"
}

variable "display_name" {
  type        = string
  description = "Display name da SA"
}

variable "description" {
  type        = string
  default     = null
  description = "Descrição opcional"
}

variable "project_roles" {
  type        = list(string)
  default     = []
  description = "Roles project-level a aplicar nessa SA"
}
