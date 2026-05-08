variable "project_id" {
  type = string
}

variable "name" {
  type        = string
  description = "Nome do service Cloud Run"
}

variable "location" {
  type    = string
  default = "southamerica-west1"
}

variable "image" {
  type        = string
  description = "Imagem Docker. Use placeholder em stg até CI/CD popular."
}

variable "service_account_email" {
  type        = string
  description = "Email da SA que executa o service"
}

variable "cpu_limit" {
  type    = string
  default = "1"
}

variable "memory_limit" {
  type    = string
  default = "512Mi"
}

variable "min_scale" {
  type    = number
  default = 0
}

variable "max_scale" {
  type    = number
  default = 10
}

variable "cloud_sql_instances" {
  type        = list(string)
  default     = []
  description = "Lista de connection_names de Cloud SQL pra montar"
}

variable "cpu_throttling" {
  type    = bool
  default = true
}

variable "startup_cpu_boost" {
  type    = bool
  default = true
}

variable "ingress" {
  type    = string
  default = "INGRESS_TRAFFIC_ALL"
}
