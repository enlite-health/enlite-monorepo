# spec 077, D800 (25/11/2026): publicação do app Android no Google Play. Tudo aqui foi criado À MÃO em enlite-prd
# (gcloud / API do Firebase, 25/11) e entra no state por `import` (executa só no apply), na ordem desarmar → importar →
# alinhar. O HCL reflete o vivo; nada aqui cria recurso novo.

# API do Google Play Developer (androidpublisher): a conta play-publisher publica builds e lê o Play Console por ela.
resource "google_project_service" "androidpublisher" {
  project            = var.project_id
  service            = "androidpublisher.googleapis.com"
  disable_on_destroy = false
}

import {
  to = google_project_service.androidpublisher
  id = "enlite-prd/androidpublisher.googleapis.com"
}

# Play Integrity: habilitada pela vinculação Play Console ↔ enlite-prd (Gabriel, 25/11). É o que o App Check
# (provedor Play Integrity) do health.enlite.mobile usa para atestar o app instalado pela loja.
resource "google_project_service" "playintegrity" {
  project            = var.project_id
  service            = "playintegrity.googleapis.com"
  disable_on_destroy = false
}

import {
  to = google_project_service.playintegrity
  id = "enlite-prd/playintegrity.googleapis.com"
}

# Conta de publicação no Play (CI e orquestrador). SEM papel de projeto: o acesso ao Play é concedido no próprio Play
# Console, não no IAM do GCP. SEM chave JSON: quem publica entra por personificação (token creator abaixo).
module "sa_play_publisher" {
  source       = "../../modules/service-account"
  project_id   = var.project_id
  account_id   = "play-publisher"
  display_name = "Enlite Play publisher (CI e orquestrador)"
}

import {
  to = module.sa_play_publisher.google_service_account.this
  id = "projects/enlite-prd/serviceAccounts/play-publisher@enlite-prd.iam.gserviceaccount.com"
}

# Personificação sem chave: o Gabriel (conta que roda o gcloud do orquestrador) assume a play-publisher. Binding NA
# PRÓPRIA SA, não no projeto.
resource "google_service_account_iam_member" "play_publisher_token_creator_gabriel" {
  service_account_id = module.sa_play_publisher.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "user:gabriel.g.stein@gmail.com"
}

import {
  to = google_service_account_iam_member.play_publisher_token_creator_gabriel
  id = "projects/enlite-prd/serviceAccounts/play-publisher@enlite-prd.iam.gserviceaccount.com roles/iam.serviceAccountTokenCreator user:gabriel.g.stein@gmail.com"
}

# App Firebase Android do pacote publicado no Play, com as impressões do certificado de upload e a SHA-256 da chave de
# APP SIGNING gerada pela Play (a que assina o APK instalado; sem ela Play Integrity/App Check recusam o app). O recurso
# só existe no google-beta (o google 5.45.2 não tem `google_firebase_android_app`, medido no schema em 25/11).
resource "google_firebase_android_app" "enlite_mobile" {
  provider     = google-beta
  project      = var.project_id
  display_name = "Enlite (Play)"
  package_name = "health.enlite.mobile"
  sha1_hashes  = ["3fc99837d56abbd9a06df7c572528abe00d467e0"]
  sha256_hashes = [
    "70792a7d1f2978fcfc9e3c66bdae59a609b538a1833257837e0607e8cc3ab8c9", # upload
    "44c42688de774298c435ce2beb13e22bbb2a3155ac5990cd6006e0f6c212f094", # app signing (Play)
  ]

  # Trava (Gabriel, 25/11): o pacote é permanente na Play e o app do Firebase não pode sumir
  # por um destroy. ABANDON só tira do state; prevent_destroy recusa o plan que tente destruir.
  deletion_policy = "ABANDON"

  lifecycle {
    prevent_destroy = true
  }
}

import {
  provider = google-beta
  to       = google_firebase_android_app.enlite_mobile
  id       = "projects/enlite-prd/androidApps/1:121472682203:android:a46079387629f63e3124fe"
}

# App Check do health.enlite.mobile com o provedor Play Integrity, mesmo TTL do health.enlite.app (3600s, lido em 25/11).
# Registrado à mão pela API do App Check (PATCH playIntegrityConfig). Enforcement por serviço NÃO é gerido aqui.
resource "google_firebase_app_check_play_integrity_config" "enlite_mobile" {
  provider  = google-beta
  project   = var.project_id
  app_id    = google_firebase_android_app.enlite_mobile.app_id
  token_ttl = "3600s"
}

import {
  provider = google-beta
  to       = google_firebase_app_check_play_integrity_config.enlite_mobile
  id       = "projects/enlite-prd/apps/1:121472682203:android:a46079387629f63e3124fe/playIntegrityConfig"
}

# Chave de upload do Play (keystore + senhas + alias). Como os demais secrets: o TF guarda só a ESTRUTURA; a versão (o
# valor) NUNCA entra no HCL nem no state — entra por `gcloud secrets versions add`. Os 4 vivem com os rótulos
# `app=enlite-mobile,uso=play-upload`, que o modules/secret não declara: no google 5.x `labels` não é autoritativo (só
# gere o que está no HCL), então o TF não os apaga; declará-los aqui faria o import virar "update in-place" de state
# (medido no plan de 25/11).
locals {
  play_upload_secrets = toset([
    "play-upload-keystore",
    "play-upload-store-password",
    "play-upload-key-alias",
    "play-upload-key-password",
  ])
}

module "secret_play_upload" {
  source     = "../../modules/secret"
  for_each   = local.play_upload_secrets
  project_id = var.project_id
  secret_id  = each.value
}

import {
  for_each = local.play_upload_secrets
  to       = module.secret_play_upload[each.value].google_secret_manager_secret.this
  id       = "projects/enlite-prd/secrets/${each.value}"
}
