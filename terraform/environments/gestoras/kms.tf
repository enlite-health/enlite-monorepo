# KMS das gestoras (spec 080, plano 4.5). Chave do chat; so a SA do servico cifra/decifra.
# Regra: SO google_kms_crypto_key_iam_member (aditivo). NUNCA _binding/_policy.
resource "google_kms_key_ring" "gestoras" {
  project  = var.project_id
  name     = "gestoras"
  location = var.region
}

resource "google_kms_crypto_key" "gestoras_chat" {
  name            = "gestoras-chat-key"
  key_ring        = google_kms_key_ring.gestoras.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "31536000s" # anual

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "gestoras_chat_service" {
  crypto_key_id = google_kms_crypto_key.gestoras_chat.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = module.gestoras_service_sa.member
}
