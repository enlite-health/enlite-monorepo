# Enlite — Catálogo de Funcionalidades

> Última atualização: 2026-03-31

Índice centralizado de todas as funcionalidades da plataforma Enlite. Cada módulo tem uma documentação detalhada em [`docs/features/`](features/).

---

## Módulos

| ID | Módulo | Descrição | Status | Doc |
|----|--------|-----------|--------|-----|
| AUTH | Autenticação & Autorização | Login worker/admin, OAuth Google, RBAC, troca de senha | Ativo | [auth.md](features/auth.md) |
| WRK | Gestão de Workers | Cadastro, perfil multi-step, documentos, status, ocupação | Ativo | [worker-management.md](features/worker-management.md) |
| VAC | Gestão de Vagas | CRUD de vagas, enriquecimento LLM, publicações, ciclo de vida | Ativo | [vacancy-management.md](features/vacancy-management.md) |
| MAT | Matching & Seleção | Matchmaking por score, funil kanban, resultado de encuadre | Ativo | [matching-selection.md](features/matching-selection.md) |
| INT | Entrevistas & Agendamento | Slots de entrevista, Google Meet links, booking | Ativo | [interview-scheduling.md](features/interview-scheduling.md) |
| IMP | Importação de Dados | Pipeline multi-fonte (Talentum, ClickUp, Ana Care) | Ativo | [data-import.md](features/data-import.md) |
| MSG | Mensageria & Notificações | WhatsApp via Twilio, templates, bulk dispatch, lembretes | Ativo | [messaging.md](features/messaging.md) |
| ANL | Analytics & Dashboards | Métricas de recrutamento, coordenadores, alertas, conversão | Ativo | [analytics-dashboards.md](features/analytics-dashboards.md) |
| WBH | Webhooks & Integrações | Talentum prescreening, Twilio callbacks, partner auth | Ativo | [webhooks-integrations.md](features/webhooks-integrations.md) |
| QIF | Fluxo Qualified → Entrevista | WhatsApp interativo self-service: convite, booking, Calendar, reminder 24h | Ativo | [qualified-interview-flow.md](features/qualified-interview-flow.md) |
| EVT | Infraestrutura de Eventos | Outbox pattern, Pub/Sub, Cloud Tasks, Cloud Scheduler | Ativo | [event-infrastructure.md](features/event-infrastructure.md) |
| ACQ | Canal de Aquisicao | Rastreamento do canal social (FB, IG, WA, LI, Site) por onde o worker chegou a vaga | Ativo | [acquisition-channel.md](features/acquisition-channel.md) |

---

## Mapa de Endpoints por Módulo

### AUTH
| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/admin/setup` | Bootstrap primeiro admin |
| POST | `/api/admin/auth/change-password` | Trocar senha admin |
| GET | `/api/admin/auth/profile` | Perfil admin autenticado |

### WRK
| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/workers/init` | Inicializar worker |
| POST | `/api/workers/save-step` | Salvar etapa do cadastro |
| GET | `/api/workers/progress` | Progresso do cadastro |
| POST | `/api/workers/me/documents/upload-signed-url` | URL assinada para upload |
| GET | `/api/workers/me/documents` | Listar meus documentos |
| GET | `/api/admin/workers` | Listar workers (admin) |
| GET | `/api/admin/workers/stats` | Estatísticas de workers |
| PUT | `/api/admin/workers/:id/status` | Alterar status worker |
| PUT | `/api/admin/workers/:id/occupation` | Alterar ocupação worker |

### VAC
| Método | Rota | Função |
|--------|------|--------|
| GET | `/api/admin/vacancies` | Listar vagas |
| POST | `/api/admin/vacancies` | Criar vaga |
| GET | `/api/admin/vacancies/:id` | Detalhe da vaga |
| PUT | `/api/admin/vacancies/:id` | Atualizar vaga |
| DELETE | `/api/admin/vacancies/:id` | Soft delete |
| POST | `/api/admin/vacancies/:id/enrich` | Enriquecer via LLM |
| GET | `/api/admin/vacancies/stats` | Estatísticas de vagas |

### MAT

> **Feature canônica:** [features/worker-job-applications/](features/worker-job-applications/README.md)

| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/admin/vacancies/:id/match` | Executar matchmaking |
| GET | `/api/admin/vacancies/:id/match-results` | Resultados do match |
| GET | `/api/admin/vacancies/:id/funnel` | Funil kanban |
| PUT | `/api/admin/encuadres/:id/move` | Mover encuadre no kanban | <!-- endpoint usa nome legado; opera sobre WJA -->

### INT
| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/admin/vacancies/:id/interview-slots` | Criar slots |
| GET | `/api/admin/vacancies/:id/interview-slots` | Listar slots |
| POST | `/api/admin/interview-slots/:slotId/book` | Agendar candidato |
| DELETE | `/api/admin/interview-slots/:slotId` | Cancelar slot |
| PUT | `/api/admin/vacancies/:id/meet-links` | Salvar links Google Meet |

### IMP
| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/import/upload` | Upload e importação (async 202) |
| GET | `/api/import/status/:id` | Status do job de importação |

### MSG
| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/admin/messaging/whatsapp` | Enviar WhatsApp por worker ID |
| POST | `/api/admin/messaging/whatsapp/direct` | Enviar WhatsApp por telefone |
| GET | `/api/admin/messaging/templates` | Listar templates |
| POST | `/api/admin/messaging/templates` | Criar template |
| POST | `/api/admin/messaging/bulk-dispatch-incomplete` | Dispatch em massa |

### ANL
| Método | Rota | Função |
|--------|------|--------|
| GET | `/api/admin/recruitment/global-metrics` | Métricas globais |
| GET | `/api/admin/recruitment/case/:caseNumber` | Análise por caso |
| GET | `/api/admin/recruitment/zones` | Distribuição por zona |
| GET | `/api/admin/dashboard/coordinator-capacity` | Capacidade coordenadores |
| GET | `/api/admin/dashboard/alerts` | Alertas de casos |
| GET | `/api/admin/dashboard/conversion-by-channel` | Conversão por canal |

### ACQ
| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/worker-applications/track-channel` | Gravar canal de aquisição do worker |

### QIF
| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/webhooks/twilio/inbound` | Resposta WhatsApp do worker (botões) |
| POST | `/api/internal/events/process` | Processa evento QUALIFIED (Pub/Sub) |
| POST | `/api/internal/outbox/process` | Envia mensagem da outbox (Pub/Sub) |
| POST | `/api/internal/reminders/qualified` | Reminder 24h (Cloud Tasks) |
| POST | `/api/internal/reminders/5min` | Reminder 5min (Cloud Tasks) |

### WBH
| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/webhooks/talentum/prescreening` | Webhook Talentum |
| POST | `/api/webhooks/twilio/status` | Callback Twilio |
| POST | `/api/webhooks/twilio/inbound` | Resposta inbound WhatsApp |

### EVT
| Método | Rota | Função |
|--------|------|--------|
| POST | `/api/internal/events/process` | Processar evento Pub/Sub |
| POST | `/api/internal/events/sweep` | Varredura de eventos órfãos |
| POST | `/api/internal/outbox/process` | Processar outbox |
| POST | `/api/internal/outbox/sweep` | Varredura outbox |
| POST | `/api/internal/reminders/qualified` | Lembrete 24h |
| POST | `/api/internal/reminders/5min` | Lembrete 5min |
| POST | `/api/internal/bulk-dispatch/process` | Bulk dispatch diário |

---

## Mapa de Páginas (Frontend)

| Rota | Página | Módulo |
|------|--------|--------|
| `/login` | Login worker (email + Google) | AUTH |
| `/register` | Registro de worker | AUTH |
| `/admin/login` | Login admin (domínio @enlite.health) | AUTH |
| `/admin/change-password` | Troca de senha obrigatória | AUTH |
| `/worker/profile` | Perfil multi-step (4 tabs) | WRK |
| `/admin` | Gestão de usuários admin | AUTH |
| `/admin/workers` | Lista de workers | WRK |
| `/admin/uploads` | Importação de arquivos | IMP |
| `/admin/vacancies` | Lista de vagas | VAC |
| `/admin/vacancies/:id` | Detalhe da vaga | VAC |
| `/admin/vacancies/:id/match` | Motor de matching | MAT |
| `/admin/vacancies/:id/kanban` | Funil kanban | MAT |
| `/admin/recruitment` | Dashboard de recrutamento | ANL |
| `/admin/dashboard/coordinators` | Dashboard de coordenadores | ANL |
