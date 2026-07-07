# Enlite Health - Backend Functions

Backend em Node.js/TypeScript seguindo Clean Architecture para Google Cloud Functions.

## Estrutura

```
src/
├── domain/         # Entidades e interfaces de repositório
├── application/    # Casos de uso (InitWorker, SaveStep)
├── infrastructure/ # Implementações (PostgresRepository)
└── interfaces/     # Cloud Functions Handlers (Express)
```

## Setup Local

1. Copie o arquivo de ambiente:
```bash
cp .env.example .env
```

2. Instale as dependências:
```bash
npm install
```

3. Inicie o Docker (PostgreSQL):
```bash
cd ..
docker-compose up -d
```

4. Execute em modo desenvolvimento:
```bash
npm run dev
```

## Compliance

- **HIPAA**: Sem logs de PII
- **Auditoria**: Todos os updates registram `updated_at`
- **UUID v4**: IDs primários para anonimização

<!-- repo transferido pra enlite-health em 2026-07-07; deploy via WIF validado -->
