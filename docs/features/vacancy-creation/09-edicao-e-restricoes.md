# 09 — Edição e Restrições

Como editar uma vaga existente, onde mora cada flow, o que pode ou não mudar e por quê.

## Entry points

| Entry point | Quando | Estado da vaga | Pode mudar... |
|---|---|---|---|
| `CreateVacancyPage` em modo edit (`/admin/vacancies/:id/edit`) | Vaga em rascunho ou link "Editar a vaga" do `AddressHasVacancyDialog` quando vaga é draft | `is_draft=true` | Tudo — perfil, endereço, schedule, status, descrição, datas |
| `VacancyDetailPage` (`/admin/vacancies/:id`) | Vaga já publicada; também via link "Editar a vaga" do `AddressHasVacancyDialog` quando vaga não é draft | `is_draft=false` | `schedule` (modal dedicado) e `status` inline |
| `VacancyModal` legacy (overlay na listagem `AdminVacanciesPage`) | Sempre, via click no ícone de edit | Qualquer | `is_draft=true`: tudo. `is_draft=false`: só `schedule` e `status` (backend bloqueia 403) |

TD-003 pendente: depreciar `VacancyModal` legacy.

## Guard-rails que protegem operadora de duplicação acidental

Antes de a vaga ser criada, dois useEffects em `CreateVacancyPage` checam o estado atual e mostram diálogo bloqueante quando há vaga conflitante:

| Trigger | Endpoint | Diálogo | Reação operadora |
|---|---|---|---|
| `selectedPatientId` muda (após escolher caso) | `GET /api/admin/vacancies/in-progress?patient_id=X` | `ResumeDraftVacancyDialog` | "Retomar" → `/edit`; "Criar nova" → ignora; "Cancelar" → desfaz seleção |
| `selectedAddressId` muda (após escolher endereço) | `GET /api/admin/vacancies/by-address?patient_address_id=X` | `AddressHasVacancyDialog` | "Editar a vaga" → `/edit` (draft) ou `/admin/vacancies/:id` (operacional); "Criar nova igual" → segue + adiciona endereço ao set de overrides; "Escolher outro endereço" → limpa selection |

Os 2 guards são complementares:

- Per-patient cobre o cenário "esqueci que estava criando uma vaga pra esse paciente outro dia" — pode ser pra qualquer endereço.
- Per-address cobre o cenário "esse endereço específico já tem uma vaga publicada que devo editar em vez de duplicar" — mais granular.

Quando o operador clica "Criar nova mesmo assim" no per-address, o frontend registra o `addressId` num `Set` em ref. A próxima troca de endereço só dispara o aviso se o novo endereço NÃO estiver no set (evita loop com a mesma decisão).

## Regra "draft vs operational"

Backend usa o flag `is_draft` (migration 168) como SSOT do estado de processo. Helper `authorizeVacancyUpdate` em [`vacancyCrudHelpers.ts`](../../../worker-functions/src/modules/matching/interfaces/controllers/vacancyCrudHelpers.ts):

```ts
const isDraft = currentRow.is_draft === true;
const OPERATIONAL_EDITABLE_FIELDS = new Set(['schedule', 'status']);

if (!isDraft) {
  const forbidden = Object.keys(updates).filter(f => !OPERATIONAL_EDITABLE_FIELDS.has(f));
  if (forbidden.length > 0) {
    return { kind: 'error', status: 403, error: `Forbidden fields for vacancy in status "${currentStatus}": ...` };
  }
}
```

`is_draft` é INDEPENDENTE de `status` (ver [04-estados-status.md](04-estados-status.md)). Vaga pode ser `is_draft=true` com qualquer `status` — wide edit é liberado. Quando publica em Talentum, `is_draft` vira `false` e o lock entra em vigor.

### Por que essa regra existe

- **Integridade do caso clínico.** Mudar paciente, perfil ou endereço de uma vaga já publicada quebra rastreabilidade com WJAs recebidas, publicações Talentum e Meet links marcados.
- **Confiabilidade da publicação.** Candidato que aplicou pra "AT 25-45 anos, CABA, AT" não pode ver o anúncio mudar pra "Cuidador 50+, Berazategui" sem ser uma vaga nova.
- **Auditoria simples.** Em vez de manter histórico de cada campo, regra é "vaga publicada é imutável exceto schedule/status". Histórico via `created_at` + status transitions.

## O que muda quando editar

### Mudou `patient_address_id` (só em draft)

1. Controller valida que o novo endereço pertence ao mesmo paciente E está ativo (`archived_at IS NULL`).
2. UPDATE em `job_postings.patient_address_id`.

### Mudou `status`

1. Validação: tem que ser canônico ([04](04-estados-status.md)).
2. UPDATE simples.
3. Setimmediate dispara `tryEnsureShortLink` se o novo status for público.

### Mudou `schedule`

1. JSONB serializado.
2. UPDATE simples.

### Mudou `patient_id` (só em draft)

1. Validação: paciente existe e não está soft-deleted.
2. Não pode ficar null.
3. `patient_address_id` precisa também mudar pra um endereço que pertence ao novo paciente (frontend força; backend valida).

### Mudou qualquer outro campo em operational

→ **403 Forbidden** com lista dos campos proibidos. Frontend deve filtrar payload pra mandar só `{ schedule, status }` quando não-draft.

## Restrições adicionais

- **Vaga não muda de endereço quando ClickUp atualiza o paciente.** Decisão arquitetural: sync versiona em vez de UPDATE in-place. Ver [06](06-endereco-servico.md).
- **`title` é auto-gerado** no INSERT. Tecnicamente editável em draft, mas frontend não expõe.
- **`description` é `''` no INSERT.** Só `talentum_description` é o campo de texto livre — escrito pela IA + revisão do operador no Step 2.
- **Edit de address arquivado é rejeitado.** Se operador tenta passar `patient_address_id` apontando pra row arquivada num PUT (draft), controller retorna 400 — endereço arquivado preserva contexto histórico apenas, novas bindings devem usar row ativa.

## Compatibilidade com WJAs existentes

Ao mudar `schedule` ou `status`, as WJAs vinculadas (`worker_job_applications.job_posting_id`) seguem apontando pra mesma vaga. Kanban deriva visibilidade do `application_funnel_stage` da WJA, não do status da vaga.

Caso de uso comum: prestador `CONFIRMED`, status da vaga sobe pra `ACTIVE`, WJA continua `CONFIRMED`. Se prestador sai, status vira `SEARCHING_REPLACEMENT` mas WJAs antigas ficam intactas — só passa a entrar novas no funil.
