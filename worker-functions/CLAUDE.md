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
