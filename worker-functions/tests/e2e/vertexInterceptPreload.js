/**
 * vertexInterceptPreload.js — spec 029, T019/T019a.
 *
 * Carregado DENTRO do container da API via `NODE_OPTIONS=--require`, montado pelo `docker-compose.test.yml`, só durante a
 * janela de medição destas duas tarefas (nunca em produção nem no compose padrão do e2e).
 *
 * Por quê isto existe: `vertex-gemini.ts` não tem NENHUMA variável de ambiente para trocar o
 * endereço do modelo (host hardcoded `aiplatform.googleapis.com`, ver cabeçalho do arquivo) — ao
 * contrário do Periskope/Axonico/Talentum, que já têm `*_BASE_URL` apontando para stub local.
 * T019 precisa dar duas voltas completas (ler tabela → montar prompt → "enviar ao modelo") para
 * prSovar ausência de cache, e T019a precisa que a chamada FALHE antes de qualquer rede sair —
 * então a interceptação tem de acontecer sem depender de nenhum arquivo em `src/` (proibido
 * editar) e sem custo de API (regra dura do projeto).
 *
 * O que este arquivo troca, SÓ NESTE PROCESSO, SÓ ENQUANTO ESTE PRELOAD ESTIVER ATIVO:
 *
 *   1. `google-auth-library`.GoogleAuth — `getAccessToken()`/`getProjectId()` resolvem local,
 *      sem NUNCA tentar o metadata server do GCE nem `oauth2.googleapis.com`. Mutação do objeto
 *      do módulo (mesmo `require` cacheado que `vertex-gemini.ts` vai usar), então funciona
 *      independente de quem carrega primeiro — desde que este preload rode antes do `npm start`
 *      (garantido pela semântica de `--require`).
 *
 *   2. `global.fetch` — qualquer URL contendo `aiplatform.googleapis.com` NUNCA chega à rede: uma
 *      resposta sintética no formato do `generateContent` do Vertex é devolvida na hora, montada a
 *      partir do próprio `systemInstruction` recebido (é ele que os testes T019/T019a conferem).
 *      Qualquer outro host do Google (`googleapis.com`, `google.internal`, metadata IP) que por
 *      algum motivo for chamado aqui é BLOQUEADO explicitamente (lança erro) em vez de passar —
 *      rede de segurança extra: se este preload estiver ativo mas algo escapar do caminho
 *      esperado, falha ruidosamente em vez de vazar uma chamada real.
 *
 * Toda interceptação é logada com o prefixo `[VERTEX-STUB]`, visível via
 * `docker logs <container da API>` (resolvido por `helpers/apiContainer.ts`) — é a prova que os testes leem para conferir o que foi "enviado ao
 * modelo", e a prova de que nenhuma chamada real saiu (a contagem aqui é o teto: se o stub nunca
 * logou uma interceptação para uma requisição, o Gemini/Vertex nunca foi tocado nela).
 */

'use strict';

const googleAuthLib = require('google-auth-library');

// O módulo exporta `GoogleAuth` via getter só-leitura (compilação TS → CJS com bindings
// "vivos") — reatribuir `googleAuthLib.GoogleAuth = ...` lança
// "Cannot set property GoogleAuth of #<Object> which has only a getter" (medido: primeira
// tentativa deste preload quebrou o boot do container). O PROTOTYPE do construtor, porém, é um
// objeto mutável comum — patchear os métodos nele afeta toda instância criada depois, sem
// precisar substituir o export.
googleAuthLib.GoogleAuth.prototype.getAccessToken = async function stubGetAccessToken() {
  return 'stub-vertex-token-e2e-only';
};
googleAuthLib.GoogleAuth.prototype.getProjectId = async function stubGetProjectId() {
  return 'stub-project-e2e-only';
};

const realFetch = global.fetch;
let interceptCount = 0;

global.fetch = async function fetchStub(url, init) {
  const urlStr = typeof url === 'string' ? url : (url && url.url) || String(url);

  if (urlStr.includes('aiplatform.googleapis.com')) {
    interceptCount++;
    let body = {};
    try {
      body = JSON.parse((init && init.body) || '{}');
    } catch {
      /* corpo não-JSON — segue com {} */
    }
    const sysText = (body && body.systemInstruction && body.systemInstruction.parts && body.systemInstruction.parts[0] && body.systemInstruction.parts[0].text) || '';

    console.log(`[VERTEX-STUB] intercepted call #${interceptCount} — NO REAL NETWORK CALL LEFT THIS PROCESS. url=${urlStr}`);
    console.log(`[VERTEX-STUB] systemInstruction=${JSON.stringify(sysText)}`);

    const responsePayload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  propuesta: 'Resumen objetivo del caso (stub e2e T019/T019a, sem chamada real).',
                  perfilProfesional: 'Perfil sugerido (stub e2e T019/T019a, sem chamada real).',
                }),
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    };

    return {
      ok: true,
      status: 200,
      json: async () => responsePayload,
      text: async () => JSON.stringify(responsePayload),
    };
  }

  if (
    urlStr.includes('googleapis.com') ||
    urlStr.includes('google.internal') ||
    urlStr.includes('169.254.169.254')
  ) {
    console.log(`[VERTEX-STUB] BLOCKED unexpected outbound Google call: ${urlStr}`);
    throw new Error(`[VERTEX-STUB] blocked unexpected outbound call to ${urlStr} — nunca deveria acontecer com este preload ativo`);
  }

  return realFetch(url, init);
};

console.log('[VERTEX-STUB] preload ativo — GoogleAuth e fetch para aiplatform.googleapis.com totalmente stubados nesta sessão (T019/T019a).');
