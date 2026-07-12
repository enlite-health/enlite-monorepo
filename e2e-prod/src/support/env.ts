/**
 * env.ts — leitura e validação das URLs de produção (12-factor).
 *
 * A suíte é um MONITOR de prod: as URLs NUNCA são hardcode aqui — vêm do ambiente
 * (Cloud Run Job em produção; .env.local / flags de CLI no dev). Se faltar, falha
 * cedo e alto, com mensagem acionável — melhor um erro claro na hora do que um
 * `undefined` virando `about:blank` e um teste verde mentiroso.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `[e2e-prod] Variável de ambiente obrigatória ausente: ${name}. ` +
        `Defina-a ao rodar (ex.: ${name}=https://... npx playwright test) ` +
        `ou em .env.local. Valores de prod estão em .env.example.`,
    );
  }
  return value.trim().replace(/\/+$/, ''); // sem barra final, pra concatenar rotas com segurança
}

export const PROD_BASE_URL = required('PROD_BASE_URL');
export const PROD_API_URL = required('PROD_API_URL');
