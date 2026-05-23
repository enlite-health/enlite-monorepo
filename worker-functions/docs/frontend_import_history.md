# Frontend — Tela de Histórico de Imports (estilo GitHub Actions)

> **Base:** API de import do Enlite Worker Functions
> **Objetivo:** lista paginada de jobs, filtro por status, detalhe com log em tempo real e botão de cancelar

---

## Visão geral dos endpoints

| Endpoint | Uso na tela |
|---|---|
| `GET /api/import/history` | Lista paginada de jobs (tabela principal) |
| `GET /api/import/queue` | Overlay de jobs ativos / na fila |
| `GET /api/import/status/:id` | Polling do status de um job específico |
| `GET /api/import/status/:id/stream` | Log em tempo real via SSE (tela de detalhe) |
| `POST /api/import/upload` | Upload de novo arquivo |
| `POST /api/import/cancel/:id` | Cancelar job queued ou em processamento |

Todos os endpoints exigem `Authorization: Bearer <token>`.

---

## Tela 1 — Lista de Jobs (tabela principal)

### Requisição

```
GET /api/import/history?page=1&limit=20&status=done
```

**Query params:**

| Param | Tipo | Default | Valores válidos |
|---|---|---|---|
| `page` | int | 1 | ≥ 1 |
| `limit` | int | 20 | 1 – 100 |
| `status` | string | (todos) | `pending` `processing` `queued` `done` `error` `cancelled` |

### Resposta

```json
{
  "success": true,
  "data": [
    {
      "id": "3f2a…",
      "filename": "planilha_operativa_março.xlsx",
      "status": "done",
      "currentPhase": "done",
      "workersCreated": 42,
      "encuadresCreated": 18,
      "encuadresSkipped": 3,
      "_comment": "histórico — importador de planilla descontinuado em 2026-05-23",
      "errorRows": 1,
      "createdBy": "admin@enlite.health",
      "createdAt": "2026-03-25T20:00:00Z",
      "startedAt": "2026-03-25T20:00:02Z",
      "finishedAt": "2026-03-25T20:00:35Z",
      "cancelledAt": null,
      "duration": "33s"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 52,
    "totalPages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}
```

### Mapeamento GitHub Actions → campos da API

| GitHub Actions | Campo da API | Notas |
|---|---|---|
| Ícone de status | `status` | Ver tabela de ícones abaixo |
| Título do run | `filename` | Nome do arquivo enviado |
| Workflow name | `currentPhase` | Fase atual do pipeline |
| Branch | `createdBy` | Quem fez o upload |
| Data | `createdAt` | Formatar como "há X minutos" |
| Duração | `duration` | Já vem calculado como string `"33s"` |
| Botão cancelar (`...`) | `POST /api/import/cancel/:id` | Visível somente para `queued` e `processing` |

### Ícones por status

| `status` | Ícone | Cor | Descrição |
|---|---|---|---|
| `pending` | relógio | cinza | Aguardando início |
| `queued` | relógio animado | amarelo | Na fila |
| `processing` | spinner | azul | Processando agora |
| `done` | ✓ | verde | Concluído |
| `error` | ✗ | vermelho | Falhou |
| `cancelled` | ⊘ | cinza | Cancelado |

### Atualização em tempo real na lista

Para jobs `processing` ou `queued` que aparecem na lista, recomenda-se polling leve:

```typescript
// Intervalo de 3s enquanto há jobs ativos na página atual
const hasActive = data.some(j => j.status === 'processing' || j.status === 'queued');
if (hasActive) {
  setTimeout(() => refetch(), 3000);
}
```

Alternativa: usar `GET /api/import/queue` para um indicador de "N imports ativos" no header
da página, sem precisar re-renderizar a tabela inteira.

---

## Tela 2 — Detalhe do Job (ao clicar em um item)

### Fluxo

```
1. Abrir a tela de detalhe do job (jobId da linha clicada)
2. Conectar ao SSE: GET /api/import/status/:id/stream
3. Renderizar eventos à medida que chegam
4. Fechar a conexão quando receber complete | error | cancelled
```

### Conectar ao SSE (JavaScript puro)

O `EventSource` nativo **não suporta headers de autorização**.
Use `fetch` com `ReadableStream` ou uma biblioteca como `eventsource-parser`:

```typescript
const response = await fetch(`/api/import/status/${jobId}/stream`, {
  headers: { Authorization: `Bearer ${token}` },
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop()!; // linha incompleta

  let currentEvent = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line === '') {
      if (dataLines.length) {
        const data = JSON.parse(dataLines.join('\n'));
        handleEvent(currentEvent, data);
        if (['complete', 'error', 'cancelled'].includes(currentEvent)) {
          reader.cancel();
          return;
        }
      }
      currentEvent = 'message';
      dataLines.length = 0;
    } else if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
}
```

### Tipos de eventos SSE

| Evento | Dados | O que renderizar |
|---|---|---|
| `phase` | `{ phase, at }` | Atualiza o step ativo no pipeline |
| `progress` | `{ percent, processedRows, totalRows, workersCreated, … }` | Barra de progresso + contadores |
| `log` | `{ ts, level, message }` | Linha no terminal scrollável |
| `queued` | `{ position, queueLength }` | Badge "Posição X na fila" |
| `complete` | resumo final | Marca status como ✓ verde |
| `error` | `{ message }` | Marca status como ✗ vermelho |
| `cancelled` | `{ by }` | Marca status como ⊘ cancelado |

### Fases do pipeline (steps do Actions)

```
upload_received → parsing → importing → post_processing → linking → dedup → done
                                                                          ↘ error
                                                                          ↘ cancelled
```

Renderizar como lista vertical de steps (igual ao Actions), destacando a fase atual
em azul e as concluídas em verde. Phases `error` e `cancelled` ficam em vermelho/cinza.

### Comportamento por status inicial do job

Ao abrir a tela de detalhe, verificar `job.status` antes de conectar ao SSE:

| `status` | Comportamento |
|---|---|
| `done` ou `error` | SSE fecha imediatamente com replay dos logs do DB + evento terminal |
| `cancelled` | SSE fecha imediatamente com evento `cancelled` |
| `queued` | SSE abre, emite `queued` com posição atual, depois eventos normais ao iniciar |
| `processing` | SSE abre, emite events à medida que avança |

Não é necessário lógica especial — o backend gerencia tudo isso automaticamente.

---

## Tela 3 — Upload de novo arquivo

```
POST /api/import/upload
Content-Type: multipart/form-data
field: "file" (xlsx, xls ou csv)

← 202 {
  importJobId,
  filename,
  message,
  queuePosition,   // 0 = iniciou agora; ≥ 1 = posição na fila
  statusUrl,
  streamUrl
}
```

Após 202, redirecionar para a tela de detalhe do job usando `streamUrl`.

---

## Cancelar um job

```
POST /api/import/cancel/:id
Authorization: Bearer <token>

← 200  { message: "Job removido da fila e cancelado." }         // era queued
← 200  { message: "Cancelamento solicitado. Parará em breve." } // era processing
← 404  job não encontrado
← 409  job já terminal (done / error / cancelled)
```

Exibir o botão de cancelar apenas quando `status === 'queued'` ou `status === 'processing'`.
Após cancelar, o SSE (se aberto) receberá o evento `cancelled` e fechará sozinho.

---

## Estado da fila (widget de status global)

```
GET /api/import/queue

← {
  "success": true,
  "data": {
    "running": {
      "jobId": "…",
      "filename": "planilha.xlsx",
      "enqueuedAt": "…"
    } | null,
    "queued": [
      { "jobId": "…", "filename": "…", "position": 1, "enqueuedAt": "…" }
    ]
  }
}
```

Usar para exibir um badge no header: **"1 import em andamento · 2 na fila"**.

---

## Filtros disponíveis na tela de lista

Idêntico às abas "Status" do GitHub Actions:

| Label na UI | `?status=` |
|---|---|
| Todos | (omitir param) |
| Em andamento | `processing` |
| Na fila | `queued` |
| Concluído | `done` |
| Falhou | `error` |
| Cancelado | `cancelled` |

---

## Paginação na UI

```typescript
// Exemplo com React Query
const { data } = useQuery({
  queryKey: ['import-history', page, limit, statusFilter],
  queryFn: () =>
    fetch(`/api/import/history?page=${page}&limit=${limit}&status=${statusFilter}`)
      .then(r => r.json()),
});

// data.pagination.hasNext  → habilitar botão "Próxima"
// data.pagination.hasPrev  → habilitar botão "Anterior"
// data.pagination.total    → exibir "52 runs"
// data.pagination.totalPages → calcular número de páginas
```

---

## Resumo das rotas para configurar no cliente HTTP

```typescript
const API = {
  history:  (p: number, l: number, s?: string) =>
    `/api/import/history?page=${p}&limit=${l}${s ? `&status=${s}` : ''}`,
  queue:    () => `/api/import/queue`,
  status:   (id: string) => `/api/import/status/${id}`,
  stream:   (id: string) => `/api/import/status/${id}/stream`,
  upload:   () => `/api/import/upload`,
  cancel:   (id: string) => `/api/import/cancel/${id}`,
};
```
