/**
 * Configuração PRÓPRIA do enquadre para os jobs da esteira pós-call (spec 052, Fase 3, T-34b). Não compartilha constante com a
 * admissão: mudar o lote de um não mexe no outro.
 *
 * LOTE do fim de call = quantos eventos uma rodada processa (o `LIMIT` da fila). A rodada é em SEQUÊNCIA e o agendador dá 300 s
 * (`attempt_deadline`): lote × tempo por evento < 300 s. Cada evento custa 1 consulta ao Meet (+ 1 resolução do espaço na primeira
 * vez) e duas transações curtas. Premissa NÃO medida ao vivo (sem chamada ao Google): 2 s por evento no pior caso, logo
 * 100 × 2 s = 200 s < 300 s. O que não coube fica para a rodada seguinte (a fila é por estado, nada se perde).
 */
export const ENQUADRE_POST_CALL_BATCH = 100;

/**
 * LOTE da importação do Tactiq = quantos eventos uma rodada importa (o `LIMIT` da fila). A rodada é em SEQUÊNCIA e o agendador dá
 * 300 s (`attempt_deadline`): lote × tempo por evento < 300 s. Um evento custa 1 busca no Tactiq + leitura de todas as páginas + escrita
 * no cofre + 1 chamada ao Vertex (gemini-2.5-pro com 8192 de thinking: "dezenas de segundos", `VertexAdmissionSummaryGenerator`) + PDF.
 * Premissa NÃO medida ao vivo (sem chamada a terceiro): 45 s por evento, logo 6 × 45 s = 270 s < 300 s. O que não coube fica para a
 * rodada seguinte (a fila é por estado e por tentativa, nada se perde); o da admissão (50) não é compartilhado.
 */
export const ENQUADRE_IMPORT_BATCH = 6;
