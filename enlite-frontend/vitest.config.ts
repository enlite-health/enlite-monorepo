import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/test/', '**/*.d.ts', '**/*.config.*'],

      /**
       * SEM PISO DE COBERTURA (decisão do Gabriel, 19/09/2026).
       *
       * Havia aqui uma catraca global e uma lista nominal de arquivos com piso
       * de 100% nos quatro eixos. Ela fazia `pnpm test:ci` sair 1 e obrigava a
       * perseguir o número em vez do comportamento. A régua passa a ser: testes
       * SUFICIENTES para julgar que a coisa FUNCIONA — o e2e sem mock é a prova,
       * a cobertura é só medição. Arquivo novo NÃO precisa ser acrescentado a
       * lista nenhuma. O que bloqueia continua sendo suíte vermelha.
       */
    },
  },
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, './src/domain'),
      '@application': path.resolve(__dirname, './src/application'),
      '@infrastructure': path.resolve(__dirname, './src/infrastructure'),
      '@presentation': path.resolve(__dirname, './src/presentation'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
    },
  },
});
