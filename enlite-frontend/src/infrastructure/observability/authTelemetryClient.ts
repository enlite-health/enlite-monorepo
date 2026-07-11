import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';

/**
 * Transporte da telemetria de login pro backend (POST /api/admin/auth/telemetry).
 *
 * Best-effort: usa `keepalive` (sobrevive ao redirect pós-login) e NUNCA lança —
 * telemetria jamais pode quebrar o login. Anexa o token Firebase quando existe;
 * a rota do backend aceita anônimo pra capturar também falhas token-less
 * (senha errada, domínio rejeitado com logout).
 */

export interface AuthTraceStep {
  step: string;
  elapsedMs: number;
  level: 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

export interface AuthTracePayload {
  traceId: string;
  flow: 'google' | 'password';
  outcome: 'success' | 'denied' | 'error';
  durationMs: number;
  steps: AuthTraceStep[];
}

const authService = new FirebaseAuthService();

function baseURL(): string {
  return (import.meta as unknown as { env?: { VITE_API_WORKER_FUNCTIONS_URL?: string } }).env
    ?.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8080';
}

export async function sendAuthTrace(payload: AuthTracePayload): Promise<void> {
  try {
    const token = await authService.getIdToken();
    await fetch(`${baseURL()}/api/admin/auth/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    /* best-effort — silencia qualquer falha (rede, sem fetch, token revogado) */
  }
}
