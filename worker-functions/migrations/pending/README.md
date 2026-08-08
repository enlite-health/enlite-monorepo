# `migrations/pending/` — migrations escritas, ainda NÃO liberadas para rodar

O runner (`scripts/run-migrations-docker.js`) lista **só o primeiro nível** de
`migrations/` (`readdirSync` sem recursão, filtrando `.sql`). Um arquivo aqui
dentro **não é aplicado** — nem no e2e, nem no boot do Cloud Run, nem por
`run-migration-prod.sh` (que recebe o caminho explícito).

É onde fica a metade **CONTRACT** de um expand/contract: escrita, revisada e
versionada junto com o expand, mas só executada depois que o deploy do expand
estiver confirmado em produção.

## Como liberar uma

1. Confirmar que **nenhuma revisão antiga** do serviço ainda está servindo
   tráfego (Cloud Run: `gcloud run revisions list`, tráfego 100% na revisão
   nova por tempo suficiente).
2. Mover o arquivo para `migrations/`, renomeando com o **próximo número livre**
   da sequência (o nome aqui não tem número de propósito, para não reservar um
   slot que outra pessoa vai querer usar antes).
3. Rodar como qualquer outra: `./scripts/run-migration-prod.sh worker-functions/migrations/<n>_<nome>.sql`.

## O que está pendente hoje

| Arquivo | Depende de | O que faz |
|---|---|---|
| `CONTRACT_drop_patients_chat_id_columns.sql` | migration `261` deployada e confirmada em produção | Derruba `patients.family_chat_id` e `patients.providers_chat_id`, que a `261` substituiu por `patient_chat_ids` |
