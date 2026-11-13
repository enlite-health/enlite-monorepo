# Spec 077 F1 bloco 1.6 (T294): identidades do attendance-service e do mobile-bff em prd.
#
# Nascem no HCL (nada criado por gcloud). Só AUTORIA: o plan é da T296.
#
# DÍVIDA HERDADA: o Cloud Run de prd está FORA do terraform (deploy por workflow, padrão
# vigente). Por isso não há módulo `cloud-run` aqui e o `run.invoker` BFF -> attendance NÃO
# entra no HCL: o serviço só existe depois do 1º deploy. Passo PÓS-DEPLOY, registrado:
#
#   gcloud run services add-iam-policy-binding attendance-service \
#     --region=southamerica-west1 --project=enlite-prd \
#     --member="serviceAccount:mobile-bff-sa@enlite-prd.iam.gserviceaccount.com" \
#     --role="roles/run.invoker"
#
# e, na sequência (ordem desarmar -> importar -> alinhar), declarar o
# `google_cloud_run_v2_service_iam_member` correspondente e alinhá-lo com:
#
#   terraform import google_cloud_run_v2_service_iam_member.bff_invokes_attendance \
#     "projects/enlite-prd/locations/southamerica-west1/services/attendance-service roles/run.invoker serviceAccount:mobile-bff-sa@enlite-prd.iam.gserviceaccount.com"
#
# Credencial do banco (decisão P8, 29/10): usuário IAM do Cloud SQL para a SA do attendance,
# SEM senha e SEM secret de senha. ATENÇÃO: a flag `cloudsql.iam_authentication` da instância é
# da T295 (`cloud_sql.tf`); o usuário IAM abaixo só funciona depois dela.

module "sa_attendance" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "attendance-sa"
  display_name = "Attendance Service"
  project_roles = [
    "roles/firebaseauth.viewer", # checkRevoked (P10) lê o usuário no Firebase Auth
  ]
}

# Sem papel de dados: o BFF não toca o banco. O run.invoker no attendance vem pós-deploy (acima).
module "sa_mobile_bff" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "mobile-bff-sa"
  display_name = "Mobile BFF"
  project_roles = [
    "roles/firebaseauth.viewer", # checkRevoked (P10) lê o usuário no Firebase Auth
  ]
}

# Postgres: o nome é o e-mail da SA SEM o sufixo `.gserviceaccount.com`. Sem `password`.
resource "google_sql_user" "attendance_iam" {
  project  = var.project_id
  instance = module.sql_enlite_ar_db.name
  name     = trimsuffix(module.sa_attendance.email, ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

# Cloud SQL só na enlite-ar-db (condição; mesmo padrão do github_deploy_cloudsql_client_ar_db em iam.tf).
resource "google_project_iam_member" "attendance_sql_ar_db" {
  for_each = toset(["roles/cloudsql.client", "roles/cloudsql.instanceUser"])
  project  = var.project_id
  role     = each.value
  member   = module.sa_attendance.member

  condition {
    title       = "only-enlite-ar-db"
    description = "spec 077: Cloud SQL do attendance so na enlite-ar-db"
    expression  = "resource.type == \"sqladmin.googleapis.com/Instance\" && resource.name == \"projects/${var.project_id}/instances/${module.sql_enlite_ar_db.name}\""
  }
}
