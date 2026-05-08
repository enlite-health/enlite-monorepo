variable "name" {
  type        = string
  description = "Nome do bucket GCS (precisa ser globalmente único)"
}

variable "location" {
  type        = string
  description = "Region/multi-region do bucket (ex: SOUTHAMERICA-WEST1, US)"
}

variable "storage_class" {
  type        = string
  default     = "STANDARD"
  description = "Storage class default do bucket"
}

variable "uniform_bucket_level_access" {
  type        = bool
  default     = true
  description = "Desabilita ACLs de objeto. Padrão é true (recomendado)."
}

variable "public_access_prevention" {
  type        = string
  default     = "inherited"
  description = "inherited ou enforced. Use enforced para bloquear acesso público."
}

variable "soft_delete_retention_days" {
  type        = number
  default     = 7
  description = "Dias de retenção em soft-delete (0 desabilita)"
}

variable "cors" {
  type = list(object({
    origins          = list(string)
    methods          = list(string)
    response_headers = list(string)
    max_age_seconds  = number
  }))
  default     = []
  description = "Regras de CORS (vazio para nenhum)"
}

variable "labels" {
  type        = map(string)
  default     = {}
  description = "Labels do bucket"
}

variable "force_destroy" {
  type        = bool
  default     = false
  description = "Permite terraform destroy mesmo com objetos dentro. Manter false em prd."
}
