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
2. **Rodar o arquivo AINDA daqui de dentro** — o script recebe caminho explícito e
   não liga para a pasta:
   `./scripts/run-migration-prod.sh worker-functions/migrations/pending/<nome>.sql`
3. **Só depois de ela ter passado**, registrar e mover, nesta ordem:
   ```sql
   INSERT INTO schema_migrations (filename) VALUES ('<n>_<nome>.sql') ON CONFLICT DO NOTHING;
   ```
   e então `git mv` para `migrations/`, com o **próximo número livre** da sequência
   (o nome aqui não tem número de propósito, para não reservar um slot que outra
   pessoa vai querer usar antes).
4. **Apagar o teste que provava a janela**, se houver. Uma suíte que simula "as duas
   colunas coexistem" perde o objeto no instante em que a CONTRACT roda — ela não
   quebrou, ela terminou. Para esta:
   `tests/e2e/blocked-attempt-contract-migration.integration.test.ts` (ele falha com
   uma mensagem dizendo isso, em vez de um `column does not exist` sem contexto).

### 🔒 Por que 2 antes de 3, e não o contrário

Mover primeiro põe o arquivo em `migrations/` — e **merge no `main` = deploy**, então
ele entra na imagem e o runner do CMD do Dockerfile o executa no boot, antes de
qualquer psql manual. Pior: se a migration **abortar** (que é o comportamento seguro
de uma trava), o arquivo continua em `migrations/` e fora de `schema_migrations`, e
**todo boot seguinte** — autoscale, restart de min-instance, próximo deploy — tenta de
novo, aborta de novo, `process.exit(1)`, o `&&` corta o `npm start`: **nenhuma
instância sobe**. O ramo desenhado para proteger o dado vira apagão.

Rodando de `pending/` e registrando antes de mover, um aborto é só um comando que
falhou no terminal de quem está olhando — que é o que um aborto deve ser.

### 🔒 Depois de liberar uma CONTRACT, ROLLBACK deixa de ser seguro

A metade CONTRACT dropa coisa que a revisão anterior ainda sabe escrever. Voltar tráfego
para ela é um clique e é a resposta padrão de incidente — e o write path afetado costuma
ser fire-and-forget, então a perda é **silenciosa**: sem 500, sem alerta, só um `warn`.

Caminho de volta correto: **redeploy da revisão nova** (ou revert do commit + deploy),
nunca `update-traffic` para a revisão velha. Quem libera avisa o time na hora.

E vale para a janela INTEIRA, não só depois: **entre o deploy do expand e a CONTRACT**, a
revisão anterior lê colunas que o código novo deixou de preencher. Ali o rollback não dá
erro — dá **número menor**, calado, em qualquer tela que ainda leia a coluna velha. Dos
dois lados, a saída de incidente é para a FRENTE.

## O que está pendente hoje

| Arquivo | Depende de | O que faz |
|---|---|---|
| `CONTRACT_drop_blocked_attempt_old_columns.sql` | migration `332` deployada e confirmada em produção (revisão ÚNICA no Cloud Run) | Fecha a janela (backfill: a `332` deliberadamente não o faz), derruba `blocked_reason` e `missing_fields` — substituídas por `*_at_attempt` — e o índice `idx_wba_blocked_reason`, que convidava à consulta errada |

## ⚠️ Migration liberada daqui PRECISA ser re-executável

`scripts/run-migration-prod.sh` roda o psql e **não** escreve em `schema_migrations`.
Assim que o arquivo sai daqui para `migrations/`, o runner do CMD do Dockerfile o vê
como não-aplicado e o **re-executa no próximo boot** do Cloud Run.

Como a metade CONTRACT costuma ser destrutiva (`DROP COLUMN`), o corpo dela referencia
coisas que ela mesma acabou de remover. Sem guard de existência, o re-run explode — e
o runner agora **falha fechado** (`exit != 0` aborta o `npm start`), então isso deixa
de ser barulho no log e vira **nenhuma instância subindo**.

Guard: `IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' ...)
THEN EXECUTE $sql$ ... $sql$; END IF;` — por existência, não por contagem; com `table_schema`,
senão uma tabela homônima noutro schema responde pela sua; e com `EXECUTE`, para o SQL não ser
nem planejado no ramo morto.

⚠️ E **`RAISE EXCEPTION` aqui não é grátis**: uma vez que o arquivo esteja em `migrations/`, ele é
`process.exit(1)` no boot. Reserve o aborto para o que o código não produz (corrupção, dado sem
recuperação possível) — nunca para uma condição que o tráfego normal cria.
