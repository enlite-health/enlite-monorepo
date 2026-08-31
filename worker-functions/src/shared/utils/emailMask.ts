/**
 * Máscara de e-mail — política ÚNICA do produto.
 *
 * Existia duplicada: `AccountLinkService.maskEmail` (fluxo de posse de conta) e,
 * desde 30/08, uma segunda cópia no domínio de pacientes, com saída divergente
 * (`kete•••@` × `jo***@`). Duas máscaras visíveis do mesmo dado, no mesmo
 * produto, é confusão para quem opera e dono duplo para quem mantém.
 *
 * Fica UMA regra: até 4 caracteres do local part, o resto oculto, domínio
 * preservado. O domínio fica porque é o que desempata na prática (gmail ×
 * hotmail × domínio corporativo) sem revelar quem é a pessoa.
 *
 * ⚠️ Devolve `null` quando a entrada não é um e-mail reconhecível — em vez de
 * ecoar a string, que poderia ser um valor inesperado vindo do banco. Chamador
 * que precisa de string sempre usa `?? '•••'`; assim a POLÍTICA é uma só e o
 * FALLBACK é decisão de quem exibe.
 */
export function maskEmail(email: string | null | undefined): string | null {
  const trimmed = (email ?? '').trim();
  const at = trimmed.lastIndexOf('@');
  // Precisa de ao menos 1 char antes do @ e um domínio com ponto depois dele.
  if (at < 1 || !trimmed.slice(at + 1).includes('.')) return null;

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  const visible = local.slice(0, Math.min(4, Math.max(1, local.length - 2)));
  return `${visible}•••${domain}`;
}
