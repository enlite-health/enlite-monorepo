# KMS for the assistants (spec 080, plan 4.5). Chat key; only the service SA encrypts/decrypts.
# Rule: ONLY google_kms_crypto_key_iam_member (additive). NUNCA _binding/_policy.
resource "google_kms_key_ring" "assistants" {
  project  = var.project_id
  name     = "assistants"
  location = var.region
}

resource "google_kms_crypto_key" "assistants_chat" {
  name            = "assistants-chat-key"
  key_ring        = google_kms_key_ring.assistants.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "31536000s" # yearly

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "assistants_chat_service" {
  crypto_key_id = google_kms_crypto_key.assistants_chat.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = module.assistants_service_sa.member
}
