/**
 * __CrashNow.tsx
 *
 * Componente de teste que força um erro no render.
 * Usado exclusivamente em DEV para validar o visual do RouteErrorBoundary.
 * Nunca incluído em produção (guardado por import.meta.env.DEV em App.tsx).
 */
export function CrashNow(): never {
  throw new Error('crash de teste — RouteErrorBoundary visual test');
}
