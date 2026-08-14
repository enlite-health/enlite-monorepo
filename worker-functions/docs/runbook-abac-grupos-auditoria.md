# Runbook — grupos de exceção cross-país e vistas de auditoria

Change `abac-pais-fase1`, tasks 5.2 e 5.3. Vale para QA e PRD (trocar o proxy/porta).
**v1 não tem UI de propósito** (design, decisão 8): grupo nasce por INSERT auditado via
este runbook; a UI é a change `admin-gestao-grupos` (Figma node `3300-20697`), depois.

## Como conectar

Sempre como **`enlite_app`** (owner) via cloud-sql-proxy — as roles do app têm
SELECT-only nas tabelas de controle de acesso e **nenhum** SELECT na trilha de leitura
(lex C2). Sessão ad-hoc como outro usuário verá zero linhas nas tabelas sob RLS (é o
fail-closed, não um erro).

```bash
cloud-sql-proxy <projeto>:southamerica-west1:enlite-ar-db --port 5434 &
PGPASSWORD=$(gcloud secrets versions access latest --secret=enlite-ar-db-password --project=<projeto>) \
  psql -h localhost -p 5434 -U enlite_app -d enlite_ar
```

## 5.2 — Conceder visão cross-país a um grupo

O modelo (migrations 268 + 271): `users` ─ `user_groups` ─ `permission_groups` ─
`group_country_scopes`. A policy resolve o grant **a cada request** — revogação tem
efeito imediato, sem esperar token. `granted_by` e `reason` são **NOT NULL**: concessão
sem justificativa é rejeitada pelo banco (spec `country-access-groups`).

### Passo 1 — criar o grupo (se não existir)
```sql
INSERT INTO permission_groups (id, tenant_id, name, description)
VALUES (
  gen_random_uuid(),
  (SELECT id FROM tenants LIMIT 1),          -- tenant único hoje
  'coordenacao-cross-pais',                   -- nome curto, kebab
  'Coordenação que atende AR e BR — aprovado por <quem> em <data>'
)
RETURNING id;
```

### Passo 2 — conceder o escopo de país ao grupo (o ato auditado)
```sql
INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason)
VALUES (
  gen_random_uuid(),
  '<group_id do passo 1>',
  'BR',                                       -- o país ADICIONAL que o grupo enxerga
  'staff:<firebase_uid de quem autorizou>',   -- mesma convenção da D95
  'Cobertura da coordenação BR até contratação local — aprovado por Marcel, <data>'
);
```
- Um grant por país: grupo que precisa ver AR **e** BR recebe duas linhas.
- O índice único parcial impede grant VIVO duplicado (re-conceder revogado = nova linha).

### Passo 3 — pôr a pessoa no grupo
```sql
INSERT INTO user_groups (user_id, group_id, tenant_id)
VALUES ('<firebase_uid>', '<group_id>', (SELECT id FROM tenants LIMIT 1));
```
⚠️ A policy também exige `users.is_active = true` — offboarding corta o grant na hora
mesmo que a linha de `user_groups` fique para trás.

### Revogar (nunca DELETE — histórico é requisito da spec)
```sql
-- o escopo inteiro do grupo:
UPDATE group_country_scopes SET revoked_at = now()
 WHERE group_id = '<group_id>' AND country = 'BR' AND revoked_at IS NULL;
-- OU só uma pessoa:
DELETE FROM user_groups WHERE user_id = '<uid>' AND group_id = '<group_id>';
```
Efeito na request seguinte (provado no e2e `country-context-app.test.ts`).

### Conferir o que está vivo
```sql
SELECT pg.name AS grupo, gcs.country, gcs.granted_by, gcs.reason,
       gcs.created_at, count(ug.user_id) AS membros
FROM group_country_scopes gcs
JOIN permission_groups pg ON pg.id = gcs.group_id
LEFT JOIN user_groups ug ON ug.group_id = gcs.group_id
WHERE gcs.revoked_at IS NULL
GROUP BY 1,2,3,4,5 ORDER BY gcs.created_at DESC;
```

### Registro obrigatório fora do banco
Toda concessão/revogação vira linha no `diario.md` do ebrain (quem pediu, quem aprovou,
até quando). O banco guarda o quê; o diário guarda o contexto.

## 5.3 — Vistas de auditoria (sem UI; SQL canônico)

Fonte: `resource_access_log` (migration 270 — particionada por mês, append-only,
**SELECT negado às roles do app**; só este caminho de owner lê). 1 linha = 1 abertura de
dossiê. `origin`: `same_country` · `group_grant` (cross-país via grupo) · `system`.

### "Quem viu os dados da pessoa X no período Y?"
```sql
SELECT ral.occurred_at, ral.operator_uid, u.email AS operador,
       ral.operator_role, ral.action, ral.origin
FROM resource_access_log ral
LEFT JOIN users u ON u.firebase_uid = ral.operator_uid   -- resolve nome; uid é o dado
WHERE ral.resource_type = 'patient'          -- ou 'worker'
  AND ral.resource_id   = '<id da pessoa>'
  AND ral.occurred_at  >= '2026-08-01' AND ral.occurred_at < '2026-09-01'
ORDER BY ral.occurred_at DESC;
```

### "O que o operador Z abriu no período Y?"
```sql
SELECT occurred_at, resource_type, resource_id, action, origin
FROM resource_access_log
WHERE operator_uid = '<firebase_uid>'
  AND occurred_at >= now() - interval '30 days'
ORDER BY occurred_at DESC;
```

### "Todo acesso CROSS-PAÍS da semana" (a vista de vigilância do grant)
```sql
SELECT date_trunc('day', occurred_at) AS dia, operator_uid,
       count(*) AS aberturas, array_agg(DISTINCT resource_type) AS tipos
FROM resource_access_log
WHERE origin = 'group_grant' AND occurred_at >= now() - interval '7 days'
GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC;
```
Uso esperado (task 6.2): contagem de cross-país da 1ª semana pós-virada. Volume alto ou
operador inesperado aqui = revisar o grant correspondente.

### Regras duras
- **Nunca** expor esta tabela à Luz nem ao conector claude.ai sem capability nova
  explicitamente aprovada (lex C2 — a trilha liga operador a paciente: É dado pessoal).
- Partição nova fora da migration precisa repetir o REVOKE (header da migration 270).
- Antes de criar partição de mês que já tem linhas na DEFAULT: drenar a DEFAULT primeiro.
