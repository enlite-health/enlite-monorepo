# Enlite Worker Functions — Guia para Claude

Backend Node.js/Express/TypeScript/PostgreSQL que gerencia o ciclo de vida de Acompanhantes Terapêuticos (ATs): importação de dados, recrutamento, matching e operação diária.

---

## Documentação de referência

| O que precisa | Onde ler |
|---|---|
| Arquitetura completa, schema do banco, roles, auth | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Regras detalhadas do pipeline de importação | [`docs/IMPLEMENTATION_RULES.md`](docs/IMPLEMENTATION_RULES.md) |
| Setup de banco e comandos SQL | [`docs/COMANDOS_CONFIGURACAO_DB.md`](docs/COMANDOS_CONFIGURACAO_DB.md) |

**Antes de qualquer mudança em schema, roles, auth ou pipeline de import: leia `docs/ARCHITECTURE.md`.**

---

## Regras que nunca mudam

- Máximo **400 linhas** por arquivo de implementação
- Controllers não contêm lógica de negócio
- Toda normalização em `import-utils.ts` — nunca inline
- LLM nunca no path síncrono — sempre background
- Migrações são aditivas: nunca dropar coluna/tabela sem deprecação
- Testes de repositório usam banco real — nunca mock
- **Logging**: `logger`/`reportError` de `@shared/logging` — nunca `console.*` em código novo. Padrão completo em [`docs/runbooks/RUNBOOK_OBSERVABILITY.md`](../docs/runbooks/RUNBOOK_OBSERVABILITY.md).

## Logger / Observabilidade

```ts
import { logger, reportError, loggingAls } from '@shared/logging';

const log = logger.child({ workerId, jobPostingId });
log.info({ msg: 'started' });

try { /* ... */ }
catch (err) {
  const e = err instanceof Error ? err : new Error(String(err));
  reportError(e, { source: 'MyUseCase:method', workerId });
}

// Em job assíncrono (handler de domain_event, outbox processor), restaurar contexto:
await loggingAls.run({ traceId: row.trace_id ?? uuidv4(), workerId }, async () => {
  await handler(row);
});
```

Cloud Logging filtra por `jsonPayload.traceId`, `jsonPayload.workerId`, `jsonPayload.batchId`. Erros vão pro Cloud Error Reporting automaticamente via `severity=ERROR` no log.

---

## PII encriptada + busca/filtro (Blind Index) — LEIA antes de filtrar qualquer campo de worker

PII de worker é encriptada em repouso via **KMS** (`KMSEncryptionService`). Há ~20 colunas `*_encrypted` na tabela `workers` (nome, sexo, idiomas, data nascimento, documento, telefone, raça, religião, etc. — ver `migrations/023_encrypt_all_pii.sql` e waves seguintes). **Coluna encriptada NÃO é filtrável em SQL** (o ciphertext é opaco; decriptar a tabela inteira por request é inviável e fere LGPD).

### Como filtrar/buscar sobre PII encriptada: Blind Index (HMAC determinístico)

Padrão CipherSweet, já implementado em `src/shared/security/BlindIndexService.ts`. Para um campo encriptado que precise ser **filtrado/buscado/matched**, cria-se uma coluna paralela `<campo>_bidx` com `HMAC-SHA256(chave, valor_normalizado)`. A chave HMAC vive no **Secret Manager** (`worker-trgm-hmac-key`), nunca no banco — então um dump vazado é irreversível. O filtro calcula o mesmo HMAC e dá match na coluna `_bidx`. Exemplos vivos: `name_trgm_bidx` (busca por nome, trigram, mig 167), `sex_bidx` + `languages_bidx` (filtros de listagem, mig 218; helper `AdminWorkersListHelpers.ts`).

### REGRA: blind index é POR CAMPO QUE SE FILTRA, não por campo encriptado

NÃO crie `_bidx` pra toda coluna encriptada. Crie **apenas** quando o campo vira filtrável/buscável. Campo que só é **exibido** (decripta 1 registro na ficha) não precisa de bidx. Por isso só 3 de ~20 colunas encriptadas têm bidx hoje. Custo evitado: storage + cálculo no write + leak de frequência (determinístico revela igualdade).

### Checklist ao tornar um campo PII filtrável

1. **Migration aditiva** `<campo>_bidx` (`BYTEA` p/ valor único, `BYTEA[]` p/ multi-valor) + índice (`btree` p/ equality, `GIN` p/ array `@>`), com `WHERE merged_into_id IS NULL` (espelhar mig 167/218).
2. **`BlindIndexService`**: usar `generateValueBidx` / `generateValuesBidx` (valor inteiro) ou `generate*TrigramBidx` (substring). Reusa a mesma chave/`loadKey`.
3. **Normalização SSOT idêntica em write + filtro + backfill** — divergência (ex: `'Masculino'` no write vs `'male'` no filtro) faz o índice nunca bater. Ex: `src/shared/utils/normalizeSexValue.ts`.
4. **Write-path**: todo lugar que grava o campo encriptado passa a gerar o bidx junto (ex: `WorkerPersonalInfoRepository`, `WorkerImportRepository`).
5. **Backfill** dos registros antigos (coluna nasce NULL; só novos writes preenchem): copiar `scripts/backfill-name-trgm-bidx.ts` — decripta KMS → normaliza → gera HMAC → UPDATE. Roda 1x após a migration; sem ele os workers existentes não aparecem no filtro.

---

## Testes E2E — obrigatório

Toda vez que um controller, route, use case ou converter for criado ou modificado: criar/atualizar o teste E2E antes de considerar a tarefa concluída.

```
1. Implementar feature
2. /e2e-create  → gera/atualiza teste E2E
3. /e2e-run     → executa (Docker se necessário, auto-repair se falhar)
```

| Modo | Comando |
|---|---|
| Docker completo (padrão local) | `npm run test:e2e:docker` |
| Firebase Emulator | `npm run test:e2e:full` |
| Stack já rodando (CI) | `npm run test:e2e` |

---

## Pipelines de import legados

**ATENÇÃO:** scripts em `scripts/import-encuadres-from-clickup.ts` (e similares de planilha operativa) são **legados e em deprecação**. Não devem ser executados regularmente.

A função `EncuadreRepository.syncToWorkerJobApplications` foi deprecada em F6 (2026-05-24) — pipeline reverso `encuadres → WJA` está morto. WJAs são populadas exclusivamente via webhook Talentum, matchmaking automático, self-service de link público, ou drag manual no Kanban. Ver `docs/features/worker-job-applications/README.md`.

Se precisar rodar import histórico (backfill manual), executar com cuidado e confirmar com PO antes.

---

## Comandos slash

| Situação | Comando |
|---|---|
| Nova fonte de dados | `/new-converter` |
| Mudança em scripts/, converters/ | `/import-checklist` |
| Nova migração de banco | `/new-migration` |
| Feature nova pronta | `/e2e-create` → `/e2e-run` |
| Testes falhando | `/e2e-repair` |
