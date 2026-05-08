variable "project_id" {
  type = string
}

variable "secret_id" {
  type = string
}

variable "replication_locations" {
  type        = list(string)
  default     = []
  description = "Lista de regions para user_managed replication. Vazio = automatic."
}
