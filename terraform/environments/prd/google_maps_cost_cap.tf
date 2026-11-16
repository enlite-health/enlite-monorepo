# Spec 077, D703 — teto de custo do Google Maps Platform em enlite-prd.
# (1) cota no projeto para Places API (New), Geocoding e as APIs legadas Places e Maps JavaScript: ~600/min e 20.000/dia;
# (2) alerta de orçamento por e-mail acima de US$ 30/mês.
# A chave é compartilhada (admin, worker-functions, mobile-bff), então o teto vale para os três.
#
# Fontes dos nomes (lidos em 16/11/2026, só leitura, como tf-admin):
#   gcloud alpha services quota list --service=places.googleapis.com --consumer=projects/enlite-prd
#   gcloud alpha services quota list --service=geocoding-backend.googleapis.com --consumer=projects/enlite-prd
# Recurso: google_service_usage_consumer_quota_override (metric/limit vão URL-encoded: "/" -> %2F).
# Só entram as métricas cujo limite efetivo hoje é MAIOR que o teto (as que já valem 600/min não são tocadas).
# O limit é o ID do limite no Service Usage ("/min/project", sem chaves; o "{project}" só aparece no campo unit do gcloud).
# Verificado por GET em consumerQuotaMetrics/<metric>/limits/<id> (200) em 16/11/2026.
# `force = true` porque o Service Usage recusa reduzir cota em mais de 10% sem ele.
# Reverter = remover o override (volta ao default do Google).

locals {
  maps_cap_per_min = "600"
  maps_cap_per_day = "20000"

  # métrica -> unidades a limitar. Limite efetivo atual entre parênteses.
  maps_quota_caps = {
    # Places API (New), service places.googleapis.com
    "places-autocomplete-min"  = { service = "places.googleapis.com", metric = "places.googleapis.com%2FAutocompletePlacesRequest", limit = "%2Fmin%2Fproject", value = local.maps_cap_per_min } # 12000
    "places-autocomplete-dia"  = { service = "places.googleapis.com", metric = "places.googleapis.com%2FAutocompletePlacesRequest", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }   # 175000
    "places-getplace-dia"      = { service = "places.googleapis.com", metric = "places.googleapis.com%2FGetPlaceRequest", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }             # 125000
    "places-searchtext-dia"    = { service = "places.googleapis.com", metric = "places.googleapis.com%2FSearchTextRequest", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }           # 75000
    "places-searchnearby-dia"  = { service = "places.googleapis.com", metric = "places.googleapis.com%2FSearchNearbyRequest", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }         # 75000
    "places-getphotomedia-dia" = { service = "places.googleapis.com", metric = "places.googleapis.com%2FGetPhotoMediaRequest", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }        # 175000

    # Geocoding, service geocoding-backend.googleapis.com
    # billable_default = o que a Geocoding API (maps/api/geocode, usada pelo worker-functions) cobra; v4/* = Geocoding API nova.
    "geocoding-billable-min" = { service = "geocoding-backend.googleapis.com", metric = "geocoding-backend.googleapis.com%2Fbillable_default", limit = "%2Fmin%2Fproject", value = local.maps_cap_per_min }               # 3000
    "geocoding-billable-dia" = { service = "geocoding-backend.googleapis.com", metric = "geocoding-backend.googleapis.com%2Fbillable_default", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }                 # ilimitado
    "geocoding-v4-addr-min"  = { service = "geocoding-backend.googleapis.com", metric = "geocoding-backend.googleapis.com%2Fv4%2Fgeocode_address_requests", limit = "%2Fmin%2Fproject", value = local.maps_cap_per_min }  # 1500
    "geocoding-v4-addr-dia"  = { service = "geocoding-backend.googleapis.com", metric = "geocoding-backend.googleapis.com%2Fv4%2Fgeocode_address_requests", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }    # ilimitado
    "geocoding-v4-loc-min"   = { service = "geocoding-backend.googleapis.com", metric = "geocoding-backend.googleapis.com%2Fv4%2Fgeocode_location_requests", limit = "%2Fmin%2Fproject", value = local.maps_cap_per_min } # 1500
    "geocoding-v4-loc-dia"   = { service = "geocoding-backend.googleapis.com", metric = "geocoding-backend.googleapis.com%2Fv4%2Fgeocode_location_requests", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }   # ilimitado
    "geocoding-v4-place-min" = { service = "geocoding-backend.googleapis.com", metric = "geocoding-backend.googleapis.com%2Fv4%2Fgeocode_place_requests", limit = "%2Fmin%2Fproject", value = local.maps_cap_per_min }    # 1500
    "geocoding-v4-place-dia" = { service = "geocoding-backend.googleapis.com", metric = "geocoding-backend.googleapis.com%2Fv4%2Fgeocode_place_requests", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }      # ilimitado

    # APIs LEGADAS usadas pelo admin (Maps JavaScript + autocomplete/Details do Places legado). Pico de 30 dias medido em 16/11/2026
    # (Monitoring, serviceruntime.googleapis.com/quota/rate/net_usage, alinhado a 60s e 86400s):
    #   places-backend billable_default: 68/min, 677/dia · maps-backend billable_default: 49/min, 348/dia · 3d_billable_default: sem uso.
    # Teto = max(600/min e 20.000/dia da D703, 3x o pico) = 600/min e 20.000/dia, bem acima do pico.
    "places-legacy-min" = { service = "places-backend.googleapis.com", metric = "places-backend.googleapis.com%2Fbillable_default", limit = "%2Fmin%2Fproject", value = local.maps_cap_per_min } # 6000
    "places-legacy-dia" = { service = "places-backend.googleapis.com", metric = "places-backend.googleapis.com%2Fbillable_default", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }   # ilimitado
    "maps-js-min"       = { service = "maps-backend.googleapis.com", metric = "maps-backend.googleapis.com%2Fbillable_default", limit = "%2Fmin%2Fproject", value = local.maps_cap_per_min }     # 30000
    "maps-js-dia"       = { service = "maps-backend.googleapis.com", metric = "maps-backend.googleapis.com%2Fbillable_default", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }       # ilimitado
    "maps-3d-min"       = { service = "maps-backend.googleapis.com", metric = "maps-backend.googleapis.com%2F3d_billable_default", limit = "%2Fmin%2Fproject", value = local.maps_cap_per_min }  # 30000
    "maps-3d-dia"       = { service = "maps-backend.googleapis.com", metric = "maps-backend.googleapis.com%2F3d_billable_default", limit = "%2Fd%2Fproject", value = local.maps_cap_per_day }    # ilimitado
  }
}

resource "google_service_usage_consumer_quota_override" "maps_cap" {
  for_each = local.maps_quota_caps

  provider       = google-beta
  project        = var.project_id
  service        = each.value.service
  metric         = each.value.metric
  limit          = each.value.limit
  override_value = each.value.value
  force          = true
}

# Orçamento: alerta por e-mail ao gastar US$ 30 no mês SÓ em Google Maps Platform (D703). Só ALERTA, não corta o gasto.
# O filtro é por serviço de faturamento (sem ele o orçamento cobriria o projeto inteiro, ~US$ 230/mês, e dispararia todo mês).
# IDs lidos em 16/11/2026 do export (bq, enlite-prd.billing_export.gcp_billing_export_v1_*, colunas service.id x service.description).
locals {
  maps_billing_service_ids = [
    "services/213C-9623-1402", # Places API
    "services/0776-5E2E-55E3", # Places API (New)
    "services/0AC2-4B25-C429", # Geocoding API
    "services/1934-AA85-20F9", # Maps API (SKU "Dynamic Maps" = Maps JavaScript API)
  ]
}

# Conta de faturamento: 01994D-5E747D-F222E1 (sufixo das tabelas gcp_billing_export_v1_* do dataset billing_export, spec 082).
# Canal: o mesmo dos alertas de prd (events_notification_channel = e-mail "Gabriel Stein (Urgente)").
# billingbudgets.googleapis.com está DESLIGADA em enlite-prd (ver nota R-28 em admission.tf): este bloco a liga.
variable "maps_budget_billing_account" {
  type        = string
  description = "ID da conta de faturamento do projeto (D703)."
  default     = "01994D-5E747D-F222E1"
}

variable "maps_budget_usd_per_month" {
  type        = number
  description = "Teto mensal (US$) do alerta de orçamento do projeto (D703)."
  default     = 30
}

resource "google_project_service" "billingbudgets" {
  project            = var.project_id
  service            = "billingbudgets.googleapis.com"
  disable_on_destroy = false
}

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_billing_budget" "projeto_mensal" {
  billing_account = var.maps_budget_billing_account
  # máx. 60 caracteres (limite da API)
  display_name = "enlite-prd: gasto Google Maps > US$ ${var.maps_budget_usd_per_month}/mês (D703)"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    calendar_period        = "MONTH"
    services               = local.maps_billing_service_ids
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.maps_budget_usd_per_month)
    }
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = [var.events_notification_channel]
  }

  depends_on = [google_project_service.billingbudgets]
}
