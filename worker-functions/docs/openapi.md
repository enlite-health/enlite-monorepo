# OpenAPI / Swagger UI — Guia do dev

A documentação interativa da API roda em **`/api/docs`** (UI Swagger) e **`/api/docs/openapi.json`** (spec).

## Quem pode acessar

- **Local / test / staging**: público se `OPENAPI_PUBLIC=true` ou `NODE_ENV !== production`.
- **Produção**: exige Firebase ID token de usuário com role staff/admin/coordinator.

Pra liberar em prod (debug pontual), setar `OPENAPI_PUBLIC=true` na env do Cloud Run e fazer rollout. **Não deixar ligado.**

## Como funciona

Cada rota Express tem um arquivo correspondente em [`src/shared/openapi/registrations/`](../src/shared/openapi/registrations/). Esses arquivos rodam side-effects no boot, registrando paths/responses/security no singleton `registry`. O `buildOpenApiDocument()` consolida tudo num spec OpenAPI 3.0.

## Checklist — adicionar/alterar rota

Sempre que tocar em uma rota Express:

1. **Identifique o arquivo de registration** apropriado em `src/shared/openapi/registrations/` (mesmo módulo / mesma tag). Crie um novo se for uma família de rotas inédita.

2. **Importe o arquivo novo** em [`registrations/index.ts`](../src/shared/openapi/registrations/index.ts) (ordem alfabética).

3. **Use os schemas reusáveis** de [`schemas/common.ts`](../src/shared/openapi/schemas/common.ts):
   - `successResponseSchema(Name, ItemSchema)` para `{ success: true, data: ... }`
   - `paginatedResponseSchema(Name, ItemSchema)` para listas com `total`
   - `ErrorResponseSchema` para todos os 4xx/5xx
   - `UuidParam` para path params UUID
   - `PaginationQuery.extend({ ... })` para query params com paginação
   - `OkMessage` para responses sem body útil

4. **Padrão de `registry.registerPath()`**:
   ```ts
   registry.registerPath({
     method: 'post',
     path: '/api/admin/foo/{id}/bar',   // converte :id → {id}
     tags: ['Admin · Foo'],              // string EXATA de TAGS_ORDER (document.ts)
     summary: 'Cria bar para foo',       // 3-8 palavras
     description: '...',                  // 1-3 frases: quando usar, side effects, idempotência
     security: [{ firebaseAuth: [] }],    // ou internalApiKey / partnerKey / twilioSignature / []
     request: {
       params: z.object({ id: UuidParam }),
       body: { content: { 'application/json': { schema: z.object({ ... }) } } },
     },
     responses: {
       201: { description: '...', content: { 'application/json': { schema: ... } } },
       400: { description: 'Validação falhou.', content: { 'application/json': { schema: ErrorResponseSchema } } },
       401: { description: 'Token ausente/inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
       500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
     },
   });
   ```

5. **Descreva cada campo do schema** com `.openapi({ description, example })`. É o que aparece no Swagger UI ao expandir o body — sem isso a doc é inútil.

6. **Rode os testes**: `npm run test:playwright:docker`. Se a rota nova não foi registrada, o teste de cobertura falha apontando exatamente qual `METHOD PATH` está faltando.

## Mapeamento de security

| Middleware Express | Security scheme |
|---|---|
| `requireAuth()`, `requireStaff()`, `requireAdmin()`, `requirePermission(...)` | `firebaseAuth` |
| `requireApiKey()`, internal token middleware | `internalApiKey` |
| `PartnerAuthMiddleware.requirePartnerKey()` (Talentum) | `partnerKey` |
| Twilio inbound/status (X-Twilio-Signature) | `twilioSignature` |
| Sem auth | `security: []` (sem entradas) |

## Como rodar a UI local

```bash
# Opção A: stack docker completo (recomendado pra validar tudo)
npm run test:playwright:docker

# Opção B: server local + acesso manual
make dev   # ou: npm run dev
# abrir http://localhost:8080/api/docs/
```

## Testes Playwright

- **`tests/playwright/swagger-coverage.spec.ts`** — sete asserções de paridade entre rotas Express e o spec.
- **`tests/playwright/swagger-ui.spec.ts`** — oito asserções da UI: tags agrupadas, summaries visíveis, botão Authorize, cadeado em rotas auth, screenshot baseline.

Pra atualizar o screenshot baseline (após mudança intencional na UI):
```bash
npm run test:playwright:update-snapshots
```

## Convenções de tags

A lista canônica está em [`document.ts:TAGS_ORDER`](../src/shared/openapi/document.ts). Sempre que adicionar uma tag nova, edite esse array — o teste `toda tag usada em operações existe na lista global de tags` falha se a tag não estiver lá.

Padrão de nomeação: `Domínio · Subdomínio` (com `·` U+00B7, não hífen). Ex: `Admin · Patients`, `Webhooks · Talentum`.
