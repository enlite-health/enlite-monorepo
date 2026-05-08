# Enlite Terraform

Infraestrutura como código para os projetos GCP `enlite-prd` e `enlite-stg`.

## Estrutura

```
terraform/
  versions.tf                    # provider pinning compartilhado
  environments/
    prd/                         # ambiente de produção (enlite-prd)
    stg/                         # ambiente de staging (enlite-stg)
  modules/
    cloud-sql/                   # instâncias Cloud SQL + databases + users
    cloud-run/                   # services Cloud Run
    secrets/                     # Secret Manager (estrutura — valores ficam fora do TF)
    storage/                     # GCS buckets
    iam/                         # service accounts e bindings
    artifact-registry/           # repos Docker
    firebase/                    # Firebase Auth + Firestore
```

## Autenticação

Não use chaves JSON. Use impersonation da SA `tf-admin@enlite-prd.iam.gserviceaccount.com`:

```bash
gcloud auth application-default login
export GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=tf-admin@enlite-prd.iam.gserviceaccount.com
```

Sua conta precisa de `roles/iam.serviceAccountTokenCreator` na SA `tf-admin` (já configurado para gabriel.g.stein@gmail.com).

## Como rodar

```bash
cd infra/terraform/environments/<env>
cp terraform.tfvars.example terraform.tfvars   # editar se necessário
terraform init
terraform plan
terraform apply
```

`<env>` é `prd` ou `stg`.

## Estado

Backend remoto em `gs://enlite-tf-state` (bucket no projeto `enlite-prd`, com versioning ativo, public access prevention e uniform bucket-level access).

- prd → `gs://enlite-tf-state/prd/default.tfstate`
- stg → `gs://enlite-tf-state/stg/default.tfstate`

## Importar recursos existentes (prd)

O ambiente `prd` foi criado manualmente antes do TF. Para adotá-lo sem recriar:

1. Escrever a `resource` no TF descrevendo o recurso existente
2. `terraform import google_<tipo>.<nome> <id-do-recurso>`
3. `terraform plan` para confirmar diff vazio (ou ajustar HCL para casar com o estado real)

Lista de recursos a importar está documentada em `docs/STAGING_PLAN.md` (a criar na Fase 1).

## Convenções

- Nunca commitar `terraform.tfvars`, `*.tfstate*`, `.terraform/`. Tudo no `.gitignore`.
- Valores de secrets vão direto no Secret Manager (via Console/CLI), nunca em TF.
- Mudanças destrutivas (`destroy`, `force_destroy`, `prevent_destroy = false`) precisam de aprovação humana antes do apply.
