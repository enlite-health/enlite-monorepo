/**
 * messageDateFormat — data/hora do CARD de mensagem (spec 022, ajustes de UI B5), no molde do
 * comentário do ClickUp que o Gabriel mostrou: "17 de sep. a las 6:13 p. m." (ES) / "17 de set. às
 * 18:13" (PT).
 *
 * 🔒 Mês por TABELA PRÓPRIA, não `Intl.DateTimeFormat(..., { month: 'short' })`: medido nesta
 * sessão (Node 20, ICU completo) — `es-AR` devolve `"sept"` (4 letras, sem ponto), não `"sep."`
 * como no exemplo. Depender do ICU do runtime também tornaria o teste NÃO determinístico entre
 * versões de Node/ICU. A HORA continua vindo do `Intl` (`hour: 'numeric', minute: '2-digit'`) —
 * essa parte JÁ bate exatamente com o exemplo nas duas línguas (`"6:13 p. m."` / `"18:13"`), sem
 * precisar de tabela.
 *
 * `connector` ("a las" / "às") vem de fora (i18n, `thread.dateConnector`) — este módulo não
 * importa `react-i18next` (função pura, testável sem provider).
 */
const MONTH_ABBR_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTH_ABBR_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** `language` é `i18n.language` (`'es'` ou `'pt-BR'`, ver `i18n/index.ts`) — só o prefixo importa. */
export function formatMessageDateTime(iso: string, language: string, connector: string): string {
  const date = new Date(iso);
  const isPt = language.toLowerCase().startsWith('pt');
  const months = isPt ? MONTH_ABBR_PT : MONTH_ABBR_ES;
  const day = date.getDate();
  const month = months[date.getMonth()];
  const time = new Intl.DateTimeFormat(isPt ? 'pt-BR' : 'es-AR', { hour: 'numeric', minute: '2-digit' }).format(date);
  return `${day} de ${month}. ${connector} ${time}`;
}
