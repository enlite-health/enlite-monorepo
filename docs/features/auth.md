# Autenticacao & Autorizacao (AUTH)

## O que e

Sistema de autenticacao e autorizacao da Enlite com dois fluxos distintos: **worker** (profissionais de saude) e **admin** (equipe interna). Workers autenticam via Firebase Auth (email/senha ou Google OAuth). Admins autenticam via painel proprio com restricao de dominio `@enlite.health`.

## Por que existe

A plataforma tem dois perfis com necessidades distintas:
- **Workers** precisam de um fluxo simples (app mobile-first) para cadastro e acesso ao perfil
- **Admins** precisam de acesso controlado ao painel de gestao com RBAC e auditoria

## Como funciona

### Fluxo Worker

```
Worker
  |  Email/senha ou Google OAuth
  v
Firebase Auth
  |  Gera authUid + JWT token
  v
Backend AuthMiddleware
  |  Verifica Firebase ID token
  |  Injeta uid no request
  v
Endpoints /api/workers/*
```

**Registro**: Worker cria conta (email/senha ou Google) -> Firebase Auth gera authUid -> `POST /api/workers/init` cria registro no banco -> reconcilia com workers pre-importados (Talentum, Ana Care) por telefone/email.

**Login**: Firebase Auth valida credenciais -> JWT token enviado em `Authorization: Bearer <token>` -> middleware valida e injeta uid.

### Fluxo Admin

```
Admin
  |  Email/senha ou Google OAuth (@enlite.health apenas)
  v
Firebase Auth
  |  Gera token
  v
AdminApiService.getProfile()
  |  Verifica se usuario e admin no banco
  |  Checa mustChangePassword
  v
Painel Admin (se autorizado)
```

**Bootstrap**: Primeiro admin criado via `POST /api/admin/setup`. Exige `ADMIN_SETUP_ENABLED=true`
no env (default off — ligar só durante o bootstrap de um ambiente novo e desligar em seguida) e
auto-desabilita apos primeiro uso (`countAdmins() > 0` → 403).

**Restricao Google OAuth**: Frontend valida que email termina em `@enlite.health` antes de permitir login admin via Google.

**Troca de senha obrigatoria**: No primeiro login, admin e redirecionado para `/admin/change-password` (minimo 8 chars, 1 maiuscula, 1 numero).

### Autorizacao (RBAC)

- **Cerbos**: Engine de autorizacao para permissoes granulares
- **SimplifiedAuthorizationEngine**: Fallback para RBAC simplificado baseado em roles
- **MultiAuthService**: Roteamento entre Firebase Auth e Partner Auth (webhooks)

## Endpoints

| Metodo | Rota | Funcao | Auth |
|--------|------|--------|------|
| POST | `/api/admin/setup` | Bootstrap primeiro admin | Publico, gated por `ADMIN_SETUP_ENABLED` (auto-desabilita) |
| POST | `/api/admin/users` | Criar admin | Admin |
| GET | `/api/admin/users` | Listar admins | Admin |
| DELETE | `/api/admin/users/:id` | Deletar admin | Admin |
| POST | `/api/admin/users/:id/reset-password` | Reset senha via email | Admin |
| POST | `/api/admin/auth/change-password` | Trocar propria senha | Admin |
| GET | `/api/admin/auth/profile` | Perfil autenticado | Admin |
| DELETE | `/api/users/me` | Deletar propria conta | Worker |
| DELETE | `/api/admin/users/by-email` | Deletar por email | Admin |

## Componentes

### Backend

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/interfaces/controllers/AdminController.ts` | CRUD admin users, bootstrap, senha |
| `src/interfaces/controllers/UserController.ts` | Delecao de conta worker |
| `src/infrastructure/services/MultiAuthService.ts` | Roteamento de auth |
| `src/infrastructure/services/CerbosAuthorizationAdapter.ts` | RBAC via Cerbos |
| `src/infrastructure/services/SimplifiedAuthorizationEngine.ts` | RBAC simplificado |
| `src/infrastructure/middleware/AuthMiddleware.ts` | Validacao Firebase JWT |
| `src/infrastructure/security/KMSEncryptionService.ts` | Criptografia PII |

### Frontend

| Arquivo | Responsabilidade |
|---------|-----------------|
| `src/presentation/pages/LoginPage.tsx` | Login worker |
| `src/presentation/pages/RegisterPage.tsx` | Registro worker (3 steps) |
| `src/presentation/pages/admin/AdminLoginPage.tsx` | Login admin |
| `src/presentation/pages/admin/AdminChangePasswordPage.tsx` | Troca senha obrigatoria |
| `src/presentation/pages/admin/AdminUsersPage.tsx` | CRUD admins |
| `src/presentation/stores/authStore.ts` | Estado auth worker (Zustand) |
| `src/presentation/stores/adminAuthStore.ts` | Estado auth admin (Zustand) |
| `src/presentation/hooks/useAuth.ts` | Hook de auth worker |
| `src/presentation/hooks/useAdminAuth.ts` | Hook de auth admin |

## Regras de negocio

- Workers pre-importados sao reconciliados por telefone, email ou authUid (padroes fake: `anacareimport_*`, `candidatoimport_*`, `pretalnimport_*`)
- Delecao de usuario faz cascading delete de todos os dados + remove do Google Identity
- Nenhum PII em logs ou mensagens de erro (conformidade HIPAA)
- Admin bootstrap so funciona se nao existe nenhum admin no banco
- Paginacao de admin list: limit 1-200, default 50

## Integracoes externas

- **Firebase Authentication**: Gerenciamento de identidade (authUid, JWT, OAuth)
- **Google Identity Service**: Operacoes de usuario (reset senha, delecao)
- **Cerbos**: Engine de autorizacao RBAC
- **EventDispatcher**: Publica eventos de criacao/delecao de usuario
