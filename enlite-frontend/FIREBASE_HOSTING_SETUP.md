# Firebase Hosting como Ponte para Cloud Run - Enlite Frontend

Este guia configura o Firebase Hosting para atuar como ponte/proxy para o Cloud Run do enlite-frontend, resolvendo problemas de região (Santiago).

## 📋 Pré-requisitos

1. **Firebase CLI instalado**
   ```bash
   npm install -g firebase-tools
   ```

2. **Login no Firebase**
   ```bash
   firebase login
   ```

## 🔧 Arquivos de Configuração

### `firebase.json`
Configurado para redirecionar todo tráfego para o Cloud Run:
- **serviceId**: `enlite-frontend` (nome do serviço no Cloud Run)
- **region**: `southamerica-west1` (Santiago)
- Headers de cache desabilitados para garantir conteúdo atualizado

### `.firebaserc`
Configurado para o projeto `enlite-prd`

### `public/index.html`
Arquivo placeholder (nunca será servido devido aos rewrites)

## 🚀 Deploy do Firebase Hosting

### 1. Fazer Deploy
```bash
firebase deploy --only hosting
```

Após o deploy, você receberá uma URL como:
```
https://enlite-prd.web.app
```

Teste essa URL para verificar se o frontend está carregando corretamente.

## 🌐 Configurar Domínio Personalizado

### 2. Adicionar Domínio no Firebase Console

1. Acesse [Firebase Console](https://console.firebase.google.com/)
2. Vá em **Hosting** → **Adicionar domínio personalizado**
3. Digite o domínio: `app.enlite.health`
4. Firebase fornecerá um registro TXT para verificação

### 3. Configurar DNS no Cloudflare

**Passo 1: Verificação (Registro TXT)**
```
Type: TXT
Name: @ ou app (dependendo do subdomínio)
Value: [valor fornecido pelo Firebase]
```

**Passo 2: Aguardar Verificação**
- Pode levar alguns minutos
- Firebase verificará automaticamente

**Passo 3: Adicionar Registros A**

Após verificação, Firebase fornecerá IPs. Adicione no Cloudflare:

```
Type: A
Name: @ ou app
Value: [IP 1 fornecido pelo Firebase]
Proxy: 🔴 Desligado (cinza) - IMPORTANTE inicialmente
```

```
Type: A
Name: @ ou app
Value: [IP 2 fornecido pelo Firebase]
Proxy: 🔴 Desligado (cinza) - IMPORTANTE inicialmente
```

**⚠️ IMPORTANTE**: Deixe o proxy do Cloudflare DESLIGADO (nuvem cinza) inicialmente para o Firebase gerar o certificado SSL.

### 4. Aguardar SSL

- Tempo: 10 minutos a algumas horas
- Acompanhe no Firebase Console → Hosting
- Status mudará para "Ativo" quando pronto

### 5. Ativar Proxy Cloudflare (Opcional)

Após SSL ativo:
1. Volte ao Cloudflare
2. Ative o proxy (nuvem laranja 🟠)
3. Verifique SSL/TLS → Overview → **Full (Strict)**

## 🔐 Variáveis de Ambiente (Opcional)

Se precisar que o Cloud Run saiba sobre o domínio customizado:

No Google Cloud Console → Cloud Run → Editar e implantar nova revisão:

```
VITE_APP_URL=https://app.enlite.health
VITE_API_URL=https://app.enlite.health
```

## ✅ Verificação Final

1. **Teste a URL do Firebase**
   ```
   https://enlite-prd.web.app
   ```

2. **Teste o domínio customizado**
   ```
   https://app.enlite.health
   ```
   
   Este será o domínio principal de produção do Enlite Frontend.

3. **Verifique SSL**
   - Deve mostrar cadeado verde
   - Certificado emitido pelo Google

4. **Teste funcionalidades**
   - Login com Google
   - Navegação entre páginas
   - Chamadas à API (worker-functions)
   - Upload de arquivos
   - Dashboard de recrutamento

## 🐛 Troubleshooting

### Erro 404
- Verifique se `serviceId` em `firebase.json` está correto
- Confirme que o serviço Cloud Run existe e está rodando

### SSL não funciona
- Aguarde mais tempo (pode levar até 24h em casos raros)
- Verifique se proxy Cloudflare está desligado
- Confirme que registros A estão corretos

### Redirecionamento infinito
- Verifique configuração SSL/TLS no Cloudflare (deve ser Full ou Full Strict)
- Confirme que não há regras de Page Rules conflitantes

### Cache issues
- Headers já configurados para `no-cache`
- Se necessário, limpe cache do Cloudflare

## 📝 Comandos Úteis

```bash
# Ver logs do deploy
firebase deploy --only hosting --debug

# Listar projetos
firebase projects:list

# Trocar projeto
firebase use [project-id]

# Ver configuração atual
firebase hosting:channel:list
```

## 🔄 Atualizações Futuras

Para atualizar a configuração:

1. Edite `firebase.json`
2. Execute:
   ```bash
   firebase deploy --only hosting
   ```

Não é necessário reconfigurar DNS ou SSL.

## 📚 Referências

- [Firebase Hosting Docs](https://firebase.google.com/docs/hosting)
- [Cloud Run Integration](https://firebase.google.com/docs/hosting/cloud-run)
- [Custom Domain Setup](https://firebase.google.com/docs/hosting/custom-domain)

<!-- 038 F4 c3: PR de prova, atrás da main de propósito -->
