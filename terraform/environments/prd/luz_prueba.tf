# Spec 086 (Luz em prueba, F2) — o worker-functions chama o triage-service (`POST /internal/luz/prueba/turn`) com ID token OIDC da PRÓPRIA SA
# (`enlite-functions-sa`, audience = URL do triage). O triage é público (webhook do Chatwoot; hoje `allUsers` é invoker): a trava da rota é o
# guard OIDC do triage (`InternalTurnGuard`). Este binding deixa a SA explícita caso o `allUsers` seja removido um dia.
#
# ⚠️ SÓ HCL — nenhum `plan`/`apply` aqui (F4c; ordem prd: desarmar → importar → alinhar). O `triage-service` NÃO está no state deste ambiente
# (os serviços Cloud Run de prd são deployados por workflow/`deploy.sh`; este diretório não tem nenhum `google_cloud_run_*` de serviço), então o
# binding aponta o serviço pelo NOME LITERAL, na mesma região/projeto. O binding ainda não existe no vivo: não há `import` a declarar.
# Conferir antes do apply: `gcloud run services get-iam-policy triage-service --region=<region>` (se a SA já for invoker por outro caminho, o
# apply é no-op para o membro, mas o recurso entra no state).
resource "google_cloud_run_v2_service_iam_member" "wf_invoca_triage_prueba" {
  project  = var.project_id
  location = var.region
  name     = "triage-service"
  role     = "roles/run.invoker"
  member   = module.sa_enlite_functions.member
}
