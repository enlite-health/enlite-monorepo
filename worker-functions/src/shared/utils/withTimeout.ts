/**
 * Orçamento de tempo para trabalho que a resposta espera mas que não pode segurá-la (Firebase Admin pendurado:
 * DNS ou Identity Platform sem resposta, CI do PR #831). Estourado o orçamento, a promessa rejeita com `label`;
 * o trabalho, se ainda correr, termina por fora.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} passou de ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
