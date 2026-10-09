# RUNBOOK — Cofre da transcrição da admissão (spec 049)

Bucket `enlite-admission-transcripts-prd` (SOUTHAMERICA-WEST1), cifrado com a chave KMS `admission-vault/admission-transcripts`.
Definido em `terraform/environments/prd/admission.tf`. **Nada deste runbook contém dado real**: use `<PLACEHOLDER>`.

## O que é e quem mexe

- O backend (`enlite-functions-sa`) só tem `roles/storage.objectCreator` neste bucket: grava (com `ifGenerationMatch=0`), não lê, não lista, não apaga, não sobrescreve.
- **Ninguém** lê no dia a dia. Leitura existe só para o **resgate** (caso jurídico, pedido do titular, auditoria).
- Quem pode pedir/autorizar o resgate: **Marcel** (decide), **Javier** e **DPO** (executam/atestam). Quem executa o `gcloud` é um membro do grupo do cofre. A composição do grupo é o **H5** (Marcel, Javier e Gabriel segundo a spec §4.4) e **está ABERTA**: enquanto a variável `admission_vault_readers_group` estiver vazia, o Terraform não concede leitura a ninguém.
- Texto da transcrição é dado clínico: **nunca** vai para chat, ticket, log, prompt ou e-mail. O resgate entrega o arquivo por canal oficial ao jurídico; este runbook não descreve conteúdo.

## Pré-condição única (H5)

1. Gabriel define o grupo (ex.: `<GRUPO_COFRE>@enlite.health`) e a lista de membros fixos, se houver.
2. Preencher `admission_vault_readers_group = "group:<GRUPO_COFRE>@enlite.health"` no `terraform.tfvars` de prd e rodar `plan`/`apply` com o "vai" do Gabriel (cria só o binding `roles/storage.objectViewer` do grupo no bucket).
3. O grupo nasce **vazio**. Membro entra só por concessão temporária (abaixo).

## Resgate: concessão temporária de leitura

Prazo máximo: **24 h** por pedido. Tudo o que segue deixa trilha.

1. **Pedido por escrito** (e-mail oficial) de Marcel ou do DPO, com: motivo, `<ID_DO_CASO>` (id interno, nunca nome do paciente), objeto(s) pedido(s), quem vai ler. Guardar o e-mail.
2. **Aprovação**: Marcel responde "aprovado" no mesmo e-mail. Sem isso, parar.
3. **Concessão**: um administrador do Workspace adiciona `<QUEM_LE>@enlite.health` ao grupo `<GRUPO_COFRE>` **com data de expiração** (Admin Console > Grupos > Adicionar membros > data de expiração = agora + 24 h). Registrar data/hora e quem concedeu.
4. **Leitura** (o próprio ato gera Data Access log e dispara o alerta `[URGENTE] Cofre da transcrição da admissão LIDO`; avise Marcel/DPO antes para o e-mail não ser tratado como incidente):
   ```
   gcloud storage ls gs://enlite-admission-transcripts-prd/<PREFIXO_DO_CASO>/ --project=enlite-prd
   gcloud storage cp gs://enlite-admission-transcripts-prd/<OBJETO> <DESTINO_LOCAL_SEGURO>/
   ```
   Se o bucket tem versões: `gcloud storage ls -a ...` e `cp` da `#<geração>` pedida.
5. **Entrega** ao jurídico por canal oficial; apagar a cópia local depois (`rm -P`/disco cifrado).
6. **Revogação** (não esperar a expiração): remover `<QUEM_LE>` do grupo ao terminar. Conferir:
   ```
   gcloud storage buckets get-iam-policy gs://enlite-admission-transcripts-prd --format=json | jq '.bindings[] | {role, n: (.members|length)}'
   ```
   (só roles e contagens; o grupo deve voltar ao estado sem o membro).
7. **Trilha** (registrar em `docs/legal/registro-operacoes.md` ou equivalente, sem conteúdo): `<ID_DO_CASO>`, pedido, aprovação, quem leu, janela (início/fim), objetos lidos (nomes), revogação.
8. **Conferir o log** do ato (Logs Explorer):
   ```
   protoPayload.serviceName="storage.googleapis.com"
   resource.labels.bucket_name="enlite-admission-transcripts-prd"
   protoPayload.methodName=("storage.objects.get" OR "storage.objects.list")
   ```
   Cada leitura deve casar com um item do passo 7. Leitura sem pedido = incidente: acionar Marcel e DPO.

## Kill-switch (suspeita de vazamento)

Desabilitar a versão primária da chave bloqueia **toda** leitura do bucket (e a escrita nova também falha: o alerta `admission.vault_write_failed` dispara — esperado):
```
gcloud kms keys versions disable <VERSAO> --key=admission-transcripts --keyring=admission-vault --location=southamerica-west1 --project=enlite-prd
```
Reabilitar com `gcloud kms keys versions enable ...`. **Não destruir** a versão: destruição é irreversível e torna os objetos ilegíveis para sempre. (A chave tem `prevent_destroy` no Terraform.)

## Retenção e Bucket Lock (depende do H6)

- Hoje: versionamento ligado, soft delete 90 d, `retention_policy` **sem trava** com prazo **provisório** de 1 ano (`admission_vault_retention_seconds`).
- O prazo definitivo e a base legal da transferência internacional são do **Marcel/jurídico (H6)**.
- Depois do H6: ajustar `admission_vault_retention_seconds` ao prazo legal, `plan`/`apply`, e só então travar. **Bucket Lock é irreversível** (o prazo só aumenta e o bucket não pode ser apagado antes dele). Travar exige mudar `is_locked = true` no HCL com o "vai" nominal do Gabriel e do Marcel; nunca por `gcloud` solto.

## Entrega das envs e passos de fecho (fora do Terraform)

1. Envs do Cloud Run `worker-functions` (nomes): `ADMISSION_TRANSCRIPT_VAULT_BUCKET`, `TACTIQ_MCP_URL`, `TACTIQ_OAUTH_CLIENT_ID`, `TACTIQ_OAUTH_REDIRECT_URL` (`<URL_PRD>/api/admin/me/tactiq-link/callback`), `TACTIQ_LINK_RETURN_URL`; opcionais `TACTIQ_OAUTH_SCOPE`, `ADMISSION_SUMMARY_MODEL`. `VERTEX_LOCATION` já existe em prd. Entrega só depois do "vai" (decisão do Gabriel; ver o relatório da F8), nunca por overwrite do workflow de prd.
2. **Cliente OAuth do Tactiq em prd**: o registro dinâmico de prd é PRÓPRIO, com o redirect de prd. Fazer depois do deploy do código, uma vez, e só então preencher `TACTIQ_OAUTH_CLIENT_ID`. O cliente é público (sem segredo novo no Secret Manager).
3. O Scheduler `admission-post-call`/`admission-import`/`admission-tactiq-check` nasce no mesmo `apply`; conferir `gcloud scheduler jobs list --location=southamerica-east1 | grep admission` e disparar uma vez à mão.
4. A fila Cloud Tasks `admission-reminders` foi criada à mão e **não** está no state (spec §11).
