# Permissões / Controle de Acessos — Referência de Design (Figma)

> Extraído via Figma MCP em 2026-06-15 do arquivo **App EnLite Pro (Copy)**
> (`6weibfyKiLH2VWWcxcIRiA`). Fluxo nomeado no board: **"Fluxo para Configurações
> de Controle de Acessos e Permissões"** (área macro: *backoffice*).
>
> Status: **discovery / não implementado**. Hoje a autorização real é trivial
> (`SimplifiedAuthorizationEngine` libera qualquer autenticado; Cerbos em standby).
> Roles existentes no código: `admin`, `recruiter`, `community_manager`.

## Telas reais identificadas

### 1. Lista de Usuários — "Acessos e Permissões"
Nodes: `9544-52591`, `9159-27964` (com modal excluir), `10364-58905` (3 linhas),
`10365-59278` (2 linhas).

- **Layout:** sidebar de ícones global + navbar com título "Acessos e Permissões:"
  e seletor de país (Argentina) + card "Equipe Tratante" > seção "Usuários".
- **Tabela — colunas:**
  - `NOME COMPLETO` (nome + cargo abaixo, ex: "Marcel Araújo / Cargo Administrativo")
  - `DEPARTAMENTO` (ex: "EnLite - Gestão")
  - `STATUS` (ex: "Ativo", "Em admissão")
  - `GRUPOS DE PERMISSÃO` (ex: "Acesso Master"; "Financeiro, Administração" — **multi-valor**)
- **Ações:** busca "Pesquisar", botão "Incluir +", por linha ícones **olho** (ver/editar)
  e **lixeira** (excluir). Modal de confirmação de exclusão ("Você tem certeza que
  deseja excluir esse usuário?" + Cancelar/Confirmar).

### 2. Modal Criar / Editar Usuário (drawer lateral direito)
Nodes: `10364-58515` (editar, preenchido, Salvar ativo),
`10364-58711` (adicionar, vazio, Salvar desabilitado).

- **Campos do formulário:**
  - `Empresa` (texto, ex: "EnLite") — **tenant**
  - `Status` (dropdown: "Ativo" / "Em admissão") — liga ciclo de vida RH ao acesso
  - `Nome do funcionário` (texto)
  - `E-mail (acesso)` (texto + ícone envelope) — **identificador de login**
  - `Departamento` (dropdown único)
  - `Cargo` (texto)
  - `Departamento` (segundo campo, **multi-select de chips removíveis**, ex:
    "Financeiro ✕", "Administração ✕") — provável "departamentos com acesso"
- **Validação:** "Salvar" desabilitado até o form ser válido.
- ⚠️ Dois campos rotulados "Departamento" (single + multi) — confirmar com a designer
  a semântica (principal vs. escopo de acesso).

### 3. Tangenciais (não-ABAC, mas no mesmo board)
- `10357-39511` — **Login** (authN): email/senha + Google OAuth + seletor de país.
- `9648-48563` — **Configurações Gerais**: toggles de notificação (Whatsapp/E-mail/Push),
  fuso horário, idioma. Referência de design system (switches/dropdowns).

### 4. Não-telas (board)
Setas/conectores de fluxo: `9030-20522`, `9097-25810`, `9030-18258`, `9097-25809`,
`9097-25805`, `9137-68632`, `9030-18235`, `9097-25807`, `9137-68634`.
Labels de seção: `9030-20524` ("backoffice"), `9049-31236` (banner do fluxo).

## Modelo de acesso que o design sugere (só o observado — não inferido)

- **Sujeito:** Usuário, identificado por e-mail de acesso.
- **Atributos do usuário (candidatos ABAC):** `Empresa`/tenant, `Status`
  (Ativo / Em admissão), `Departamento` (single + multi-valor), `Cargo`.
- **Agrupamento:** "Grupos de Permissão" nomeados (ex: "Acesso Master") associados
  N:N ao usuário.

## ⚠️ Lacunas de design (não existem nos 19 nodes extraídos)

1. **Tela de definição de um Grupo de Permissão** — matriz `recurso × ação`,
   o "coração" do RBAC/ABAC. Não está em nenhum node; provavelmente é destino de
   uma das setas de fluxo não seguidas.
2. **Herança / regras de atributo** — não há UI de policy/condição.
3. **Catálogo de recursos e ações** — não definido visualmente.

> Para fechar o design da feature, pedir à designer (ou seguir as setas no Figma)
> os nodes de **criação/edição de grupo de permissão** e da **matriz recurso-ação**.
