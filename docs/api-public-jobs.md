# API Pública — Listagem de Vagas (`/api/public/v1/jobs`)

Endpoint público (sem autenticação) que lista as vagas disponíveis para candidatura. Destinado a consumo externo (site WordPress, integrações de parceiros).

---

## URL

**Produção:**

```
GET https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs
```

> ⚠️ Hoje a URL é a do Cloud Run cru. O custom domain `api.enlite.health` ainda não foi configurado (acompanhado em TD-015 do `FOLLOWUPS.md`).

**Autenticação:** nenhuma. O endpoint é totalmente público.

**Rate limit:** 60 requisições por minuto por IP.

**Cache:**
- `Cache-Control: public, max-age=300, s-maxage=600` (5 min navegador / 10 min CDN)
- Cada combinação de query params é uma chave de cache distinta

---

## Quando uma vaga aparece

Para aparecer na resposta, a vaga precisa atender **todas** as condições:

1. `status` ∈ `ACTIVE`, `SEARCHING`, `SEARCHING_REPLACEMENT`, `RAPID_RESPONSE`
2. `deleted_at IS NULL`
3. Possuir link público em `social_short_links.site`
4. Bater com os filtros passados (ver tabela abaixo)

Vagas com status `CLOSED`, `SUSPENDED`, `PENDING_ACTIVATION` ou sem link público **nunca** aparecem.

---

## Query params

Todos opcionais.

| Param | Tipo | Default | Comportamento |
|---|---|---|---|
| `country` | `string` (2 chars, ISO-3166-alpha-2) | `AR` | **Filtro mestre.** Sempre aplicado. Aceita lowercase (`ar` → `AR`). |
| `state` | `string` | — | Match case-insensitive em `state` do endereço |
| `city` | `string` | — | Match case-insensitive em `city` do endereço |
| `pathology` | `string` | — | Busca parcial (ILIKE) no diagnóstico do paciente |
| `worker_sex` | `FEMALE` \| `MALE` \| `BOTH` | — | Sexo requerido para o(a) profissional |
| `worker_type` | `string` (ex: `AT`, `CUIDADOR`) | — | Tipo de profissional requerido (match em array) |
| `q` | `string` | — | Busca textual livre em título, patologia, bairro, estado/cidade |

**Importante:** todos os filtros são aplicados como `AND` sobre o subset filtrado por `country`. Não há `OR` entre filtros.

**Quando algum param é inválido:** retorna `400 Bad Request` (ver seção [Erros](#erros)).

---

## Schema da resposta

```json
{
  "success": true,
  "data": [
    {
      "id": "935a88a6-88c5-44ac-b1ce-e6526244069c",
      "case_number": 766,
      "vacancy_number": 638,
      "title": "CASO 766-638",
      "status": "SEARCHING",
      "description": "AT con experiencia en TEA domicilio.",
      "schedule_days_hours": "Lunes a Viernes 09:00-13:00",
      "worker_profile_sought": "Experiencia previa con menores",
      "service": ["AT"],
      "pathologies": "Trastorno Bipolar",
      "country": "AR",
      "state": "Provincia de Buenos Aires",
      "city": "Provincia de Buenos Aires",
      "neighborhood": "Temperley",
      "state_city": "Provincia de Buenos Aires / Provincia de Buenos Aires",
      "worker_type": ["AT"],
      "worker_sex": "BOTH",
      "job_zone": null,
      "detail_link": "https://go.enlite.health/flZvbo"
    }
  ]
}
```

### Campos (19 no total)

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | `string (uuid)` | Identificador único da vaga |
| `case_number` | `number` | Número do caso clínico (chave humana da operação) |
| `vacancy_number` | `number` | Número sequencial da vaga dentro do caso |
| `title` | `string` | Título da vaga, padrão `"CASO {case_number}-{vacancy_number}"` |
| `status` | `string` | Um de `ACTIVE`, `SEARCHING`, `SEARCHING_REPLACEMENT`, `RAPID_RESPONSE` |
| `description` | `string` | Descrição da vaga. Texto genérico ("Caso operacional importado…") é sanitizado para `""` |
| `schedule_days_hours` | `string \| null` | Dias e horários em texto livre (ex: `"Lunes a Viernes 08-14"`) |
| `worker_profile_sought` | `string \| null` | Perfil de profissional desejado em texto livre |
| `service` | `string[] \| null` | Serviços do paciente (ex: `["AT"]`, `["CUIDADOR"]`) |
| `pathologies` | `string \| null` | Diagnóstico/patologia do paciente |
| `country` | `string \| null` | País ISO-2 (`AR`, `BR`, `US`…). Hoje só há `AR` em produção |
| `state` | `string \| null` | Estado/província do endereço |
| `city` | `string \| null` | Cidade do endereço |
| `neighborhood` | `string \| null` | Bairro do endereço |
| `state_city` | `string \| null` | Concatenação `"{state} / {city}"` (`null` se ambos vazios) |
| `worker_type` | `string[] \| null` | Tipos de profissional aceitos (ex: `["AT"]`, `["AT", "CUIDADOR"]`) |
| `worker_sex` | `string \| null` | Sexo requerido (`FEMALE`, `MALE`, `BOTH`) |
| `job_zone` | `string \| null` | Zona inferida (uso interno, pode estar vazio) |
| `detail_link` | `string` | URL pública pra ver detalhes da vaga / candidatar-se |

---

## Erros

### `400 Bad Request` — params inválidos

```json
{
  "success": false,
  "error": "Invalid query params",
  "details": [
    {
      "code": "invalid_string",
      "path": ["country"],
      "message": "Invalid"
    }
  ]
}
```

Causas comuns:
- `country` com mais ou menos de 2 caracteres (ex: `?country=ARGENTINA`)
- `worker_sex` fora do enum (ex: `?worker_sex=INVALID`)
- Params vazios (`?state=`)

### `500 Internal Server Error`

```json
{
  "success": false,
  "error": "Failed to fetch public jobs"
}
```

Erro inesperado no servidor. Reportar no canal de suporte da Enlite.

---

## Exemplos `curl`

### 1. Listar todas as vagas argentinas (default)

```bash
curl 'https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs'
```

Equivalente a `?country=AR`.

### 2. Listar vagas brasileiras (hoje retorna vazio)

```bash
curl 'https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs?country=BR'
```

### 3. Vagas em CABA com paciente com Alzheimer

```bash
curl 'https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs?country=AR&state=CABA&pathology=Alzheimer'
```

### 4. Vagas para profissional mulher em Quilmes

```bash
curl 'https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs?country=AR&city=Quilmes&worker_sex=FEMALE'
```

### 5. Busca textual livre

```bash
curl 'https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs?country=AR&q=temperley'
```

Busca em título, patologia, bairro e estado/cidade simultaneamente.

### 6. Validar erro 400

```bash
curl -i 'https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs?country=ARGENTINA'
# HTTP/2 400
# { "success": false, "error": "Invalid query params", "details": [...] }
```

---

## Integração WordPress (recomendações)

### Server-side (recomendado)

Chamar o endpoint via PHP (`wp_remote_get`) e renderizar HTML estático. Vantagens:
- Sem problema de CORS
- Conteúdo indexável pelo Google (SEO)
- Cache do WP empilha com o cache HTTP do endpoint

```php
$response = wp_remote_get(
  'https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs?country=AR'
);
$body = json_decode( wp_remote_retrieve_body( $response ), true );
$jobs = $body['data'] ?? [];
// Renderizar $jobs no template
```

### Client-side (JS no navegador)

**Atenção:** o CORS do endpoint hoje **só permite** `app.enlite.health`, localhost e n8n. Se o WordPress for chamar via `fetch()` do navegador, o domínio do WP precisa ser adicionado ao allowlist. Solicitar via canal de infra.

### Páginas por país

Cada página de país no WP deve passar `?country=` explícito:

| Página WP | URL | Observação |
|---|---|---|
| `/vagas-argentina/` | `?country=AR` | Default — funciona sem param também |
| `/vagas-brasil/` | `?country=BR` | Hoje retorna vazio |
| `/vagas-eua/` | `?country=US` | Hoje retorna vazio |

### Atualização dos dados

- O endpoint tem cache 5 min (navegador) / 10 min (CDN)
- Após uma vaga ser fechada, ela pode continuar aparecendo por até 10 min até o cache expirar
- Para forçar atualização imediata em produção, abrir ticket de infra (purge no CDN)

---

## Mudanças e versionamento

A path `/v1/` faz parte do contrato. Mudanças não-retrocompatíveis (renomear campo, mudar tipo, remover campo) **devem** publicar um `/v2/` e deprecar `/v1/` com janela mínima de 90 dias.

**Mudanças retrocompatíveis liberadas a qualquer momento:**
- Adicionar novos campos opcionais na resposta
- Adicionar novos query params opcionais
- Adicionar novos valores ao enum `status` (consumer deve aceitar valores desconhecidos)

---

## Suporte

- **Status do endpoint:** monitorado internamente; alerta em PagerDuty se erro 5xx > 1% por 5 min
- **Bugs / dúvidas:** abrir ticket no canal #infra-enlite ou contato com a engenharia
- **Solicitar liberação de CORS pra novo domínio:** ticket de infra
