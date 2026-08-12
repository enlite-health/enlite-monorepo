# Canal de Aquisicao (ACQ)

## O que e

Rastreamento do canal social (Facebook, Instagram, WhatsApp, LinkedIn, Site) por onde um worker chegou a uma vaga. A informacao e capturada no momento da postulacao e exibida como badge colorido no Kanban de candidaturas (WJA).

## Por que existe

A Enlite gera short links (via Short.io) com UTM params para cada canal de divulgacao de vagas. Antes desta feature, o `utm_source` chegava na URL da pagina publica mas ninguem capturava — a informacao de canal se perdia. Sem saber de onde os workers vem, o time de recrutamento nao consegue medir efetividade de canais nem otimizar investimento em divulgacao.

## Como funciona

### Fluxo completo

```
1. Admin gera short link para vaga (ex: go.enlite.health/abc)
   POST /api/admin/vacancies/:id/social-links { channel: "facebook" }
   -> Short.io cria URL com utm_source=facebook
     |
2. Worker clica no link -> redirect para PublicVacancyPage
   /vacantes/caso{X}-{Y}?utm_source=facebook
     |
3. PublicVacancyPage captura utm_source -> sessionStorage
   enlite_utm_source = "facebook"
   enlite_vacancy_return_url = "/vacantes/caso1-2"
     |
4. Worker clica "Postularse"
   +-- Nao autenticado? -> /register (returnUrl preservado) -> volta a vaga
   +-- Cadastro incompleto? -> modal -> completa -> volta e clica de novo
   +-- Tudo OK:
       a) Le enlite_utm_source do sessionStorage
       b) POST /api/worker-applications/track-channel { jobPostingId, channel }
       c) Limpa sessionStorage
       d) window.open(whatsappUrl) -> Talentum
     |
5. Backend faz upsert em worker_job_applications.acquisition_channel
   First-touch wins: se ja tem canal, nao sobrescreve
     |
6. Kanban exibe badge colorido no card do worker
   GET /api/admin/vacancies/:id/funnel -> acquisitionChannel por candidatura (WJA)
```

### Persistencia via sessionStorage

O `sessionStorage` preserva o canal durante navegacoes na mesma aba:
- Worker nao logado -> registra em /register -> volta a vaga -> canal ainda disponivel
- Worker com cadastro incompleto -> completa -> volta e clica de novo -> canal ainda disponivel
- Morre ao fechar a aba (nao polui)

### Canais suportados

| Canal | utm_source | Cor do badge |
|-------|-----------|-------------|
| Facebook | `facebook` | bg-blue-100 text-blue-700 |
| Instagram | `instagram` | bg-pink-100 text-pink-700 |
| WhatsApp | `whatsapp` | bg-green-100 text-green-700 |
| LinkedIn | `linkedin` | bg-sky-100 text-sky-700 |
| Portal/Site | `site` (ou `portal_jobs`) | bg-gray-100 text-gray-600 |

### Normalizacao

- `portal_jobs` (gerado pelo VacancySocialLinksController para canal `site`) e normalizado para `site` no frontend
- Valores fora da whitelist sao ignorados (nao gravados)

## Endpoints

| Metodo | Rota | Funcao |
|--------|------|--------|
| POST | `/api/worker-applications/track-channel` | Gravar canal de aquisicao (auth worker) |

**Endpoint existente modificado**:
| Metodo | Rota | Mudanca |
|--------|------|---------|
| GET | `/api/admin/vacancies/:id/funnel` | Retorna `acquisitionChannel` por candidatura (WJA) |

## Componentes

### Backend

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/interfaces/controllers/WorkerApplicationsController.ts` | Controller do track-channel |
| `src/interfaces/routes/workerApplicationsRoutes.ts` | Rota do endpoint |
| `src/interfaces/controllers/EncuadreFunnelController.ts` | Retorna acquisitionChannel no funnel <!-- nome legado; será renomeado na F7 do plano. Ver [features/worker-job-applications/02-vocabulario.md](worker-job-applications/02-vocabulario.md) --> |
| `migrations/130_add_acquisition_channel.sql` | Coluna acquisition_channel |

### Frontend

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/presentation/pages/public/PublicVacancyPage.tsx` | Captura utm_source em sessionStorage |
| `src/presentation/hooks/usePostularseAction.ts` | Envia canal ao backend no postularse |
| `src/presentation/pages/RegisterPage.tsx` | Retorno a vaga apos registro |
| `src/infrastructure/http/WorkerApiService.ts` | Metodo trackAcquisitionChannel |
| `src/presentation/components/features/admin/Kanban/KanbanCard.tsx` | Badge de canal |
| `src/presentation/components/features/admin/Kanban/KanbanBoard.tsx` | Passa acquisitionChannel aos cards |
| `src/hooks/admin/useEncuadreFunnel.ts` | Campo acquisitionChannel na interface <!-- nome legado; será renomeado na F7 do plano. Ver [features/worker-job-applications/02-vocabulario.md](worker-job-applications/02-vocabulario.md) --> |

## Schema

```sql
-- worker_job_applications (migration 130)
acquisition_channel VARCHAR(30)  -- nullable, sem default
-- Valores: facebook, instagram, whatsapp, linkedin, site
```

## Regras de negocio

- **First-touch wins**: o primeiro canal registrado e preservado; cliques posteriores nao sobrescrevem
- **Fire-and-forget**: falha no POST de tracking nao impede o postularse (WhatsApp abre normalmente)
- **Separacao de conceitos**: `source` = sistema de origem (manual, talentum, talent_search); `acquisition_channel` = canal social de captacao
- **Protecao Talentum**: o upsert do webhook Talentum nao toca `acquisition_channel` (protecao por omissao — coluna ausente do SET)
- **Worker sem UTM**: se acessou a vaga sem short link (URL direta), `acquisition_channel` fica null — sem badge no kanban
- **Whitelist**: apenas 5 canais validos; qualquer outro valor e rejeitado pelo backend (Zod validation)

## Integracoes externas

- **Short.io**: Gera os short links com UTM params (feature pre-existente em VacancySocialLinksController)
- **sessionStorage (browser)**: Persistencia temporaria do canal durante o fluxo de registro/completar cadastro
