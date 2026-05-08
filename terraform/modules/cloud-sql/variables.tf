variable "project_id" {
  type = string
}

variable "name" {
  type        = string
  description = "Nome da instância Cloud SQL"
}

variable "region" {
  type    = string
  default = "southamerica-west1"
}

variable "zone" {
  type        = string
  description = "Zona específica (ex: southamerica-west1-b). Influencia disponibilidade ZONAL."
}

variable "database_version" {
  type    = string
  default = "POSTGRES_15"
}

variable "tier" {
  type        = string
  description = "Tier da máquina (ex: db-f1-micro, db-custom-1-3840)"
}

variable "disk_size_gb" {
  type    = number
  default = 20
}

variable "disk_type" {
  type    = string
  default = "PD_SSD"
}

variable "availability_type" {
  type    = string
  default = "ZONAL"
}

variable "backup_start_time" {
  type    = string
  default = "03:00"
}

variable "backup_retained_count" {
  type    = number
  default = 7
}

variable "transaction_log_retention_days" {
  type    = number
  default = 7
}

variable "deletion_protection" {
  type        = bool
  default     = true
  description = "Bloqueia terraform destroy. Liga em prd."
}

variable "ipv4_enabled" {
  type    = bool
  default = true
}

variable "require_ssl" {
  type    = bool
  default = true
}

variable "ssl_mode" {
  type    = string
  default = "TRUSTED_CLIENT_CERTIFICATE_REQUIRED"
}

variable "authorized_networks" {
  type = list(object({
    name  = string
    value = string
  }))
  default = []
}

variable "edition" {
  type    = string
  default = "ENTERPRISE"
}
