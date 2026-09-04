# Etapa 1: Build da aplicação
FROM node:20-alpine AS build

# Receber variáveis de ambiente VITE_* via build-args
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_CERBOS_URL
ARG VITE_API_WORKER_FUNCTIONS_URL
ARG VITE_API_WORKER_FUNCTIONS_DIRECT_URL
ARG VITE_GOOGLE_MAPS_API_KEY
ARG VITE_CLARITY_PROJECT_ID

# Tornar disponíveis como ENV durante o build
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY
ENV VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN
ENV VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID
ENV VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET
ENV VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID
ENV VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID
ENV VITE_CERBOS_URL=$VITE_CERBOS_URL
ENV VITE_API_WORKER_FUNCTIONS_URL=$VITE_API_WORKER_FUNCTIONS_URL
ENV VITE_API_WORKER_FUNCTIONS_DIRECT_URL=$VITE_API_WORKER_FUNCTIONS_DIRECT_URL
ENV VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY
ENV VITE_CLARITY_PROJECT_ID=$VITE_CLARITY_PROJECT_ID

# Instalar pnpm globalmente
RUN npm install -g pnpm@8.15.5

WORKDIR /app

# Copiar apenas arquivos de definição de pacotes primeiro
COPY package.json pnpm-lock.yaml ./

# Instalar dependências (frozen-lockfile garante que a versão seja exata)
RUN pnpm install --frozen-lockfile

# Copiar apenas os arquivos de configuração que REALMENTE existem no seu projeto
# Removi o tsconfig.app.json e o tailwind.css que causaram o erro no seu log
COPY tsconfig.json \
     tsconfig.node.json \
     vite.config.ts \
     tailwind.config.js \
     postcss.config.js \
     .eslintrc.cjs \
     index.html ./

# Copiar a pasta de código fonte
COPY src ./src

# `pnpm build` roda `tsc` sobre `src` inteiro — inclusive os testes de paridade
# (`src/test/permission-parity.test.ts`, `feature-parity.test.ts`), que importam o
# gerador de fixtures. Sem estes dois arquivos o build da imagem morre com TS2307
# (deploy da stage de 04/09/2026). Só o que o tsc precisa; nada disso vai para o dist.
COPY scripts/sync-permission-catalog.mjs scripts/sync-permission-catalog.d.mts ./scripts/

# Copiar pasta public com arquivos estáticos
COPY public ./public

# Executar o build (Isso gera a pasta /app/dist)
RUN pnpm build

# Etapa 2: Servidor de Produção (Nginx)
FROM nginx:stable-alpine

# Remover configuração padrão do Nginx
RUN rm /etc/nginx/conf.d/default.conf

# Copiar configuração customizada do Nginx (com suporte a SPA routing)
COPY nginx.conf /etc/nginx/conf.d/

# Copiar os arquivos estáticos do estágio de build para o diretório do Nginx
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]