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
  // INVARIANTE: o local part NUNCA sai inteiro. `len - 2` é sempre menor que
  // `len`, então sempre sobra caractere oculto — e com 1 ou 2 chars nada é
  // revelado. A versão anterior usava `max(1, len - 2)`, que garantia 1 visível
  // e, com local part de 1 caractere, mostrava o endereço todo
  // (`a@gmail.com` → `a•••@gmail.com`). Achado do lex em 31/08, C8.
  // O TETO de 4 é o autorizado; crescer exige parecer novo.
  const visible = local.slice(0, Math.max(0, Math.min(4, local.length - 2)));
  return `${visible}•••${domain}`;
}

/**
 * Mascara e-mail PARA LOG — sempre `***@dominio`, NUNCA os até-4-caracteres que
 * `maskEmail` mostra pra tela. Mesma divisão de responsabilidade que
 * `maskPhone` (tela) × `maskPhoneForLog` (log) já usa em `phoneMask.ts`: tela e
 * log têm níveis de exposição aceitáveis diferentes, e o log tem retenção mais
 * longa e é lido por mais gente (Cloud Logging).
 *
 * O local part NUNCA pode aparecer em log — nem em claro, nem os 4 caracteres
 * de `maskEmail`, nem um hash dele — porque tem entropia baixa (não é senha, é
 * nome.sobrenome) e por isso é REVERSÍVEL por dicionário: quem lê o log testa
 * candidatos ("joao", "j.silva", ...) até bater, sem precisar quebrar nada.
 * Era exatamente o defeito da 1ª versão do extinto `redactContact` (usava
 * sha256(local-part).slice(0,6)) — achado do lex, C4, 11/09. A queda segura
 * aceita pelo lex é esta: e-mails diferentes do MESMO domínio saem
 * INDISTINGUÍVEIS no log (`***@dominio` para todos) — o domínio identifica o
 * provedor, não a pessoa. Correlacionar e-mails sem reversão pediria HMAC com
 * chave em Secret Manager (padrão de `BlindIndexService`), infraestrutura fora
 * do escopo deste helper.
 *
 * NUNCA usar para exibição ao usuário — use `maskEmail`.
 */
export function maskEmailForLog(email: string | null | undefined): string {
  const trimmed = (email ?? '').trim();
  if (!trimmed) return '(vazio)';

  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return '***';

  const domain = trimmed.slice(at + 1);
  return `***@${domain}`;
}
