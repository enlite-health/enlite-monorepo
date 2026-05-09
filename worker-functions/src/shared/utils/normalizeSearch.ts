/** Remove diacríticos (acentos) e coloca em lowercase para busca normalizada: "José" → "jose" */
export function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
