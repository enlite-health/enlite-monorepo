# 01 — Conceito

## O que é um Worker Job Application (WJA)

WJA é o **registro de candidatura** de UM prestador (worker) a UMA vaga (job posting). Modela a relação `worker × vaga` ao longo do tempo, com seu estado atual e histórico de transições.

Tabela canônica: `worker_job_applications`.

## Por que essa entidade existe

A operação de recrutamento da Enlite precisa rastrear, para cada par `(worker, vaga)`:

- **Onde o prestador está no funil** (foi convidado? respondeu? confirmou entrevista?)
- **Como chegou até aqui** (matchmaking automático? clicou no link público? veio pelo Talentum?)
- **O que está agendado** (data/hora da entrevista, link do Meet, slot escolhido)
- **Histórico de mudanças** (auditoria de transições de stage)

Um único registro WJA carrega tudo isso de forma normalizada e consistente.

## Cardinalidade — regra dura

**1 WJA por par `(worker_id, job_posting_id)`.** Garantido por:

```sql
UNIQUE (worker_id, job_posting_id)
```

Implicações:

- Se um prestador já candidatado ao Caso #766 receber nova mensagem de match, **não cria nova WJA** — o upsert detecta e respeita a existente.
- Se um prestador clica no link público de uma vaga onde já tem WJA, o endpoint retorna a existente sem duplicar.
- Re-agendamento de entrevista (REPROGRAMAR) **edita** a WJA existente — nunca cria nova linha. Ver [06-regra-cardinalidade.md](06-regra-cardinalidade.md).

## Ciclo de vida

```
INVITED → INITIATED → IN_PROGRESS → COMPLETED → (QUALIFIED | IN_DOUBT)
                                                       ↓
                                                  CONFIRMED (worker agendou via WhatsApp)
                                                       ↓
                                                  SELECTED  (terminal positivo: admin confirmou)
                                                       ou
                                                  REJECTED  (terminal negativo)
```

Notas:
- `NOT_QUALIFIED` foi removido em F3 (migration 191) — auto-vira REJECTED automaticamente no `ProcessTalentumPrescreening` quando Talentum reporta esse status.
- `REPROGRAM` foi removido em F7.b (migration 195). Worker que pede reagendamento via WhatsApp agora fica em `application_funnel_stage='CONFIRMED'` com `interview_response='awaiting_reschedule'` + `interview_meet_link=NULL` como distinguidor. Ver ADR-003 seção F7.b.
- `ANALYZED` é valor de transporte interno do mapper Talentum; nunca foi persistido em `worker_job_applications.application_funnel_stage`. Limpeza do tipo TS feita em F7.a.

Estados intermediários e a representação visual completa estão em [04-estados-funil-kanban.md](04-estados-funil-kanban.md).

## O que WJA NÃO é

- **Não é o evento da reunião presencial.** Documentação verificada na hora da entrevista (CV, DNI, certificados) e observações textuais pós-conversa moram em `encuadres.has_*` e `encuadres.obs_*` (legado, leitura apenas). Ver [07-tabelas-envolvidas.md](07-tabelas-envolvidas.md).
- **Não é o estado externo no Talentum.** O log do que aconteceu no sistema parceiro vive em `talentum_prescreenings` e suas tabelas-filhas. WJA reflete o estado **interno na Enlite**, derivado dos webhooks.
- **Não é a vaga em si.** WJA é a relação entre prestador e vaga. Atributos da vaga (paciente, endereço, descrição) moram em `job_postings`.
