# agentes — contrato HTTP dos pedidos do Sol (spec 078, M3b-1)

Base `/api/admin`, staff autenticado. Envelope: `{success:true,data}` ou `{success:false,code}`.
Células: `pedidos_ia:read` (GET) e `pedidos_ia:decidir` (POST). Sem credencial 401; conta não-staff ou sem célula 403.

## Leitura (`pedidos_ia:read`)
- `GET /pedidos-ia?area=&status=&grave=` -> 200 `data: Pedido[]` (mais novo primeiro).
  `status` in novo|aceito|negado|redirecionado; `grave` true|false (true = `grave_gatilho` != nenhum); outro valor 400 `INVALID_QUERY`.
- `GET /pedidos-ia/:id` -> 200 `data: Pedido`; id inexistente ou não-uuid 404 `NOT_FOUND`.
- `Pedido = {id, assunto, autor, area, grave_gatilho, status, criado_em, idade_h,
  atitude_atual:{versao,degrau,conteudo,caso_teste,metrica_alvo,janela,gatilho_rollback},
  eventos:[{acao,actor_uid,actor_kind,ts,motivo?,comentario?}]}`. `status` vem da view `pedido_status` (último evento).
- Ler não grava nada. O filtro por área é só parâmetro; restringir pelo nível de acesso do gestor é da M6.

## Decisão (`pedidos_ia:decidir`) — cada POST grava 1 linha em `pedido_eventos`
Presa à atitude de MAIOR `versao`, `actor_uid` = uid do staff, `actor_kind='humano'`. Resposta 200 `data:{evento_id,status}`.
- `POST /pedidos-ia/:id/aceitar` (sem body) -> status `aceito`. O `evento_id` é o id de aprovação (itens 20/48).
- `POST /pedidos-ia/:id/negar` `{motivo}` -> `negado`. Sem motivo (vazio/branco) 400 `MOTIVO_OBRIGATORIO`.
- `POST /pedidos-ia/:id/descrever` `{comentario}` -> `redirecionado`. Sem comentário 400 `COMENTARIO_OBRIGATORIO`.
  NÃO cria atitude nova: o Sol redige a próxima versão (worker M3b) e lê o comentário. Pode repetir.
- Pedido inexistente 404 `NOT_FOUND`. 2ª decisão (aceitar ou negar) na mesma atitude 409 `DECISAO_JA_REGISTRADA`.
- Falha inesperada 500 `INTERNAL_ERROR`.

## Para a tela
Rótulos de célula (es/pt-BR) já em `admin.access.group.cells.resource.pedidos_ia` e `...action.decidir`. Ao registrar a tela em
`screenRegistry.ts` com `cells: ['pedidos_ia:read','pedidos_ia:decidir']`, retirar essas 2 células da lista "fora das telas" em
`screenRegistry.test.ts`.
