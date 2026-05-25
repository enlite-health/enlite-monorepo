# 02 — Vocabulário: 3 nomes, 1 entidade

Esta feature carrega 3 nomes diferentes ao longo do código, do banco e das telas. **Todos referem-se à mesma entidade.**

## Tabela de tradução

| Nome | Onde aparece | Idioma / origem | Status |
|---|---|---|---|
| **Worker Job Application (WJA)** | Schema (`worker_job_applications`), classes que tocam o funil (`WJAFunnelController` após F7.a), hooks (`useWJAFunnel`), tipos TS | Inglês / padrão SaaS de ATS (Aya, Trusted, Vivian) | **Canônico — usar em código novo. Prefix `WJA*` (sigla curta) é o padrão estabelecido.** |
| **Encuadre** | Tabela legada `encuadres`, classes que tocam EXCLUSIVAMENTE essa tabela (`EncuadreController`, `EncuadreRepository`, `EncuadreQueryRepository`, `EncuadreMappers`, `EncuadreControllerHelpers`, `WorkerEncuadresCard`), vocabulário operacional da equipe | Espanhol / herança da operação argentina + planilha legada | **Operacional — usar ao falar com a operação. Em código: MANTÉM em classes que tocam a tabela `encuadres` (regra ADR-003, ampliada em F7.b com destino canônico do reschedule); deprecada em novos campos. Nota F8 (2026-05-25): coluna `encuadres.origen` foi renomeada para `encuadres.import_source_audit` — auditoria de import histórico apenas, sem authority sobre origem (SSOT é `wja.source`).** |
| **Funil de Candidatura** / **Kanban de Candidaturas** | UI (i18n pt-BR/es), labels, textos para usuário final | Português / camada de apresentação | **Apresentação — usar em copy de UI nova** |

## Por que existem 3 nomes

Histórico:

1. A operação argentina/espanhola da Enlite sempre chamou o ato de "encaixar prestador em vaga" de **encuadre**.
2. A primeira implementação técnica veio de uma **planilha operativa** importada para uma tabela `encuadres` no banco.
3. Quando surgiu a necessidade de suportar fluxos novos (webhook Talentum, matchmaking automático, link público), uma segunda tabela `worker_job_applications` foi criada — porque a tabela `encuadres` herdada estava acoplada ao formato da planilha.
4. As duas tabelas conviveram, gerando duplicação de dados e múltiplos pipelines de escrita.
5. Em 2026-05-23, decisão arquitetural: **consolidar SSOT em `worker_job_applications`**; `encuadres` vira tabela legada em deprecação progressiva.

## Regras de uso por contexto

### Em código novo (backend e frontend)

- Nomeie classes, métodos e variáveis usando o **prefixo `WJA*`** (sigla canônica do projeto). Ex.: `WJAFunnelController`, `useWJAFunnel`, `WJARepository`.
- Quando a classe TOCA exclusivamente a tabela `encuadres` (campos `has_*`, `obs_*`, `role`, `resultado` narrativo, identidade fallback), MANTÉM o prefixo `Encuadre*`. Regra formalizada em **ADR-003**.
- Não crie novos campos em `encuadres`. Use `worker_job_applications`.
- Em comentários explicativos, pode mencionar "(também conhecido como encuadre)" se ajudar clareza.

### Em conversas com a operação

- Use **encuadre**. É o termo que a equipe operacional usa no dia-a-dia.
- Se houver risco de ambiguidade técnica, esclareça: "encuadre = registro de candidatura na tabela `worker_job_applications`".

### Em copy de UI (telas, mensagens ao usuário final)

- Prefira **candidatura** ou **funil de candidatura** em português.
- Em telas em espanhol, **encuadre** continua válido (vocabulário local).

### Em endpoints de API

- Endpoints existentes (`/api/admin/encuadres/:id/move`, `/api/admin/vacancies/:id/funnel`) permanecem com nomes atuais. Renomeação seria breaking change sem ganho proporcional.
- Endpoints novos: nomear com **`worker-applications`** ou **`applications`**.

## O que não fazer

- ❌ Tratar "encuadre" e "WJA" como entidades distintas em código novo.
- ❌ Criar novos campos em `encuadres` para representar estado/agendamento — usar `worker_job_applications`.
- ❌ Documentar fluxos novos usando vocabulário misturado ("o encuadre é criado e depois a WJA é atualizada"). São a mesma coisa.

## Conflito com docs antigas

Documentos no repositório criados antes de 2026-05-23 podem tratar encuadre e WJA como entidades separadas com pipelines paralelos. Esses trechos estão em revisão (auditoria F1.b) e serão reescritos para alinhar com este vocabulário.
