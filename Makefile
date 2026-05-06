.PHONY: dev dev-fresh down reset snap emulator-logs test-integration

# Absolute path of the directory holding this Makefile — used in `test-integration`
# so the trap (which runs after `cd enlite-frontend`) still resolves docker-compose
# config files and `--env-file` correctly.
ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

COMPOSE = docker compose \
	-f $(ROOT_DIR)/worker-functions/docker-compose.yml \
	-f $(ROOT_DIR)/worker-functions/docker-compose.dev.yml \
	-f $(ROOT_DIR)/docker-compose.prod-auth.yml \
	--env-file $(ROOT_DIR)/.env

COMPOSE_MOCK_AUTH = docker compose \
	-f $(ROOT_DIR)/worker-functions/docker-compose.yml \
	-f $(ROOT_DIR)/worker-functions/docker-compose.dev.yml \
	-f $(ROOT_DIR)/worker-functions/docker-compose.mock-auth.yml \
	--env-file $(ROOT_DIR)/.env

COMPOSE_EMULATOR = docker compose -f $(ROOT_DIR)/docker-compose.emulator.yml

# Sobe banco + backend + frontend com Firebase Auth de produção.
# NÃO mexe no Postgres local — preserva o que você já tem.
# Para popular o banco com dados de prod, rode `make snap` (uma vez ou quando
# quiser dados frescos).
dev:
	@$(COMPOSE) build api
	grep -v 'VITE_FIREBASE_AUTH_EMULATOR' .env > enlite-frontend/.env
	$(COMPOSE) up -d --remove-orphans postgres api
	@PIDs=$$(lsof -ti :5173); [ -n "$$PIDs" ] && kill -9 $$PIDs && echo "🔪  Porta 5173 liberada." || true
	@while lsof -ti :5173 >/dev/null 2>&1; do sleep 0.2; done
	cd enlite-frontend && pnpm dev

# Snapshot fresco de prod + sobe tudo.
dev-fresh:
	$(MAKE) snap
	$(MAKE) dev

# Logs do Firebase Auth Emulator (container separado).
emulator-logs:
	$(COMPOSE_EMULATOR) logs -f

# Para todos os containers sem apagar volumes (dados preservados).
down:
	$(COMPOSE) down
	@$(COMPOSE_EMULATOR) down 2>/dev/null || true

# Para todos os containers E apaga volumes (banco zerado).
# Próximo `make snap` repopula a partir de prod.
reset:
	$(COMPOSE) down -v
	@$(COMPOSE_EMULATOR) down -v 2>/dev/null || true

# Dump completo de prod → restore no Postgres local. Schema + dados 1:1, FKs
# preservadas, sem anonimização. Precisa do container enlite-postgres rodando
# (sobe com `make dev` uma vez).
snap:
	@scripts/dump-prod-to-local.sh

# Roda os integration E2E (real backend + Postgres real). Faz swap temporário
# do api pra USE_MOCK_AUTH=true antes do teste e restaura prod-auth no fim
# (mesmo que o teste falhe). Precisa do `pnpm dev` rodando em :5173 — veja
# CLAUDE.md.
test-integration:
	@echo "🔁  Switching api to USE_MOCK_AUTH=true..."
	@$(COMPOSE_MOCK_AUTH) up -d --no-deps api
	@until curl -sf http://localhost:8080/health > /dev/null 2>&1; do sleep 1; done
	@echo "✅  API ready (mock auth). Running integration tests..."
	@trap '$(COMPOSE) up -d --no-deps api > /dev/null 2>&1; echo "🔁  api restored to prod-auth"' EXIT INT TERM; \
		cd enlite-frontend && pnpm test:e2e:integration $(ARGS)
