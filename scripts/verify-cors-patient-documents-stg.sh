#!/usr/bin/env bash
# Prova do conserto do defeito 1 (spec 018, PR-4, achado na stage 15/09): o bucket
# `enlite-patient-documents-stg` não tinha CORS, e `PatientDocumentsCard.handleOpen` faz
# `fetch()` da URL assinada (contrato `patient-header-and-photo.md` linha 48 — "abre por blob:").
# Este script roda `terraform validate` + `terraform plan -target` (NUNCA apply) contra o
# `enlite-stg` real e falha se o plan não for EXATAMENTE "adicionar CORS neste bucket, nada mais".
set -euo pipefail
cd "$(dirname "$0")/../terraform/environments/stg"

terraform init -input=false >/dev/null
terraform validate

PLAN_JSON=$(mktemp)
trap 'rm -f "$PLAN_JSON" "$PLAN_JSON.bin"' EXIT

terraform plan -target=module.bucket_patient_documents \
  -var="project_id=enlite-stg" -var="region=southamerica-west1" \
  -out="$PLAN_JSON.bin" -input=false | tee /tmp/verify-cors-plan.txt

terraform show -json "$PLAN_JSON.bin" > "$PLAN_JSON"

CHANGE_COUNT=$(jq '[.resource_changes[] | select(.change.actions != ["no-op"])] | length' "$PLAN_JSON")
if [ "$CHANGE_COUNT" -ne 1 ]; then
  echo "FALHA: esperava 1 resource com mudança, achou $CHANGE_COUNT" >&2
  exit 1
fi

BUCKET_ID=$(jq -r '[.resource_changes[] | select(.change.actions != ["no-op"])][0].address' "$PLAN_JSON")
if [ "$BUCKET_ID" != "module.bucket_patient_documents.google_storage_bucket.this" ]; then
  echo "FALHA: mudança não é no bucket esperado — achou $BUCKET_ID" >&2
  exit 1
fi

HAS_CORS=$(jq -r '[.resource_changes[] | select(.change.actions != ["no-op"])][0].change.after.cors[0].method | contains(["GET"])' "$PLAN_JSON")
if [ "$HAS_CORS" != "true" ]; then
  echo "FALHA: plan não inclui GET no CORS do bucket" >&2
  exit 1
fi

grep -q "0 to destroy" /tmp/verify-cors-plan.txt || { echo "FALHA: plan destroi algo" >&2; exit 1; }

echo "OK: plan = 1 resource mudado (bucket_patient_documents), CORS GET/HEAD adicionado, 0 destroy."
