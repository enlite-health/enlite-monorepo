# Checklist de Decomposição em Tasks

Cada task do Plano de Execução **deve** passar nestes 7 checks. Se falhar em qualquer um, decomponha ou redesenhe — nunca inclua "com ressalva".

---

## Os 7 checks

### 1. Acionável

**Pergunta:** Um dev pega esta task e sabe exatamente o que codar sem perguntar?

- ✅ "Adicionar coluna `case_number` (text, unique parcial) em `patients` via migration 117"
- ❌ "Melhorar identificação de pacientes"

Se a task usa verbos vagos (melhorar, otimizar, refatorar, ajustar), reescreva com verbo + objeto + critério.

---

### 2. Observável

**Pergunta:** O critério de aceite pode ser verificado por teste automatizado ou inspeção visual?

- ✅ "Endpoint retorna 409 com `{ code: 'CASE_NUMBER_EXISTS' }` quando case_number já existe"
- ❌ "Endpoint trata caso de duplicidade adequadamente"

Critérios não-observáveis ("user-friendly", "performático", "robusto") são proibidos.

---

### 3. Granular (≤ 1 PR)

**Pergunta:** Esta task cabe em UM pull request razoável (até ~300 linhas alteradas, ignorando migrations)?

- ✅ "Criar use case `CreatePatient` + controller + rota" (1 PR backend)
- ❌ "Implementar fluxo completo de cadastro de paciente do form ao DB" (vira 3-4 tasks)

Se a task gera diff > 300 linhas (excluindo migrations e arquivos gerados), decomponha.

---

### 4. Camada única

**Pergunta:** A task fica em uma camada da Clean Architecture (ou um lado claro do monorepo)?

- ✅ "Backend: criar entidade `Patient` em `worker-functions/src/domain/patient/`"
- ✅ "Frontend: criar `PatientForm` em `enlite-frontend/src/presentation/patients/`"
- ❌ "Backend + Frontend: implementar cadastro de paciente completo"

Tasks cross-camada são raras e exigem justificativa explícita (ex: contrato de API novo). Padrão: separar.

---

### 5. Dependências explícitas

**Pergunta:** Se esta task depende de outra, está nomeado QUAL e POR QUE?

- ✅ "Depende de Task 1 (entidade Patient) — usa `Patient.case_number`"
- ❌ "Depende de outras tasks" / silêncio

Sem dependências mapeadas, sequenciamento é impossível e tasks bloqueiam-se em runtime.

---

### 6. Testes nomeados

**Pergunta:** Os critérios de aceite incluem QUAIS testes adicionar/atualizar?

- ✅ "Unit: `Patient.spec.ts` cobre case_number único; E2E: cenário de duplicidade retorna 409"
- ❌ "Adicionar testes"

Frontend: lembrar que todo teste E2E DEVE ter `toHaveScreenshot()` (regra Enlite).

---

### 7. Sem efeitos invisíveis

**Pergunta:** A task altera algo fora dos arquivos listados? (banco em prod, env vars, secrets, configs compartilhadas, feature flags, jobs cron)

Se sim, a task deve listar EXPLICITAMENTE:
- Migrations (número e ambiente)
- Env vars novas (com valor default e onde configurar)
- Secrets novos (com instrução de criação)
- Configs compartilhadas modificadas

Tasks que mudam infra sem declarar geram surpresa em deploy. Zero tolerância.

---

## Anti-padrões frequentes do PO Enlite

| Anti-padrão | Por que falha | Correção |
|---|---|---|
| "Refatorar X para ficar mais limpo" | Não-observável | Definir métrica: linhas reduzidas, duplicação removida, etc. |
| "Implementar feature Y" como task única | Não-granular | Quebrar em entidade, use case, controller, rota, UI, testes |
| "Adicionar logging adequado" | Vago + sem critério | Especificar eventos, payload, nível (info/warn/error) |
| "Sincronizar com ClickUp" sem método | Cross-camada + sem contrato | Separar: webhook vs polling vs CLI; definir mapper |
| Task sem teste | Frontend sem screenshot é violação | Sempre nomear arquivo de teste |
| "Cleanup de arquivos órfãos" misturado com feature | Duas naturezas | Separar em commit/task próprio |

---

## Quando NÃO decompor

A regra dos 7 checks visa qualidade, não burocracia. Tasks que NÃO precisam ser decompostas:

- Bug fix de 1 linha + teste de regressão → 1 task baixa-complexidade
- Rename/typo + atualizações de referência → 1 task baixa-complexidade
- Adição de campo i18n → 1 task baixa-complexidade

Para essas, vale ainda escrever os critérios de aceite no template — mas sem fragmentar.
