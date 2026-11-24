# Spec 077 F3c (DP-26, D734, D770): política de senha do Identity Platform de prd.
# Mínimo 8 + maiúscula + minúscula + número + caractere especial, modo Notify (forceUpgradeOnSignin=false):
# contas existentes não são forçadas; vale para senha criada ou trocada daqui em diante.
#
# Por que terraform_data + local-exec e não google_identity_platform_config: o provider google 5.45.2 e o
# google-beta 7.31.0 não têm `password_policy_config` (medido no schema em 24/11). A API `passwordPolicyConfig`
# (identitytoolkit admin/v2) é a fonte; o PATCH usa só o updateMask dela e não toca em mais nada da config.
# O gatilho é o JSON da política: mudou a política, o PATCH roda de novo.
#
# Apply só com o "vai" do Gabriel, manual e com -target (nenhum workflow aplica o terraform de prd):
#   export GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=tf-admin@enlite-prd.iam.gserviceaccount.com
#   terraform apply -target=terraform_data.identity_password_policy

locals {
  # Nomes iguais aos da API (passwordPolicyConfig.passwordPolicyVersions[].customStrengthOptions).
  password_policy = {
    min_password_length                 = 8
    contains_uppercase_character        = true
    contains_lowercase_character        = true
    contains_numeric_character          = true
    contains_non_alphanumeric_character = true
    force_upgrade_on_signin             = false
  }

  password_policy_body = jsonencode({
    passwordPolicyConfig = {
      passwordPolicyEnforcementState = "ENFORCE"
      forceUpgradeOnSignin           = local.password_policy.force_upgrade_on_signin
      passwordPolicyVersions = [{
        customStrengthOptions = {
          minPasswordLength                = local.password_policy.min_password_length
          containsUppercaseCharacter       = local.password_policy.contains_uppercase_character
          containsLowercaseCharacter       = local.password_policy.contains_lowercase_character
          containsNumericCharacter         = local.password_policy.contains_numeric_character
          containsNonAlphanumericCharacter = local.password_policy.contains_non_alphanumeric_character
        }
      }]
    }
  })
}

resource "terraform_data" "identity_password_policy" {
  triggers_replace = local.password_policy_body

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    environment = {
      PROJECT_ID = var.project_id
      BODY       = local.password_policy_body
      TF_ADMIN   = "tf-admin@${var.project_id}.iam.gserviceaccount.com"
      MIN_LENGTH = local.password_policy.min_password_length
    }
    command = <<-EOT
      set -euo pipefail
      URL="https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config"
      TOKEN="$(gcloud auth print-access-token --impersonate-service-account="$TF_ADMIN")"
      curl --fail-with-body -sS -X PATCH "$URL?updateMask=passwordPolicyConfig" \
        -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT_ID" \
        -H 'Content-Type: application/json' -d "$BODY" >/dev/null
      curl --fail-with-body -sS "$URL" \
        -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT_ID" \
        | jq -e --argjson min "$MIN_LENGTH" '
            .passwordPolicyConfig as $p
            | $p.passwordPolicyEnforcementState == "ENFORCE"
            and (($p.forceUpgradeOnSignin // false) == false)
            and ($p.passwordPolicyVersions | last | .customStrengthOptions.minPasswordLength) == $min' >/dev/null
    EOT
  }
}
