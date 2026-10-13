/**
 * enquadreColumns — as 4 colunas do kanban do evento (spec 052 §4). `CONVOKED` é novo; os outros 3 têm os MESMOS ids
 * de estágio da vaga (mesmo estágio, mesmo nome). Todas aceitam soltar; evento encerrado desliga o arrasto no card.
 */
import type { EnquadreColumnId } from '@domain/entities/EnquadreEvent';

export interface EnquadreColumnDef {
  id: EnquadreColumnId;
  /** Classe de cor do bolinha do cabeçalho. */
  color: string;
}

export const ENQUADRE_COLUMNS: readonly EnquadreColumnDef[] = [
  { id: 'CONVOKED', color: 'bg-blue-400' },
  { id: 'SELECTED', color: 'bg-green-500' },
  { id: 'QUICK_RESPONSE_TEAM', color: 'bg-teal-500' },
  { id: 'REJECTED', color: 'bg-red-400' },
];

/** Alvos do "Mover a…" do evento. Rejeitados fica de fora: tem o botão "Rechazar" (pede o motivo). */
export const ENQUADRE_MOVE_TARGETS = ['CONVOKED', 'SELECTED', 'QUICK_RESPONSE_TEAM'] as const;

/** Largura da coluna: 4 colunas + 3 vãos de 12px (1236px) cabem sem rolagem horizontal em 1440px, com o título "Equipo de Respuesta Rápida" inteiro. */
export const ENQUADRE_COLUMN_WIDTH = 'w-[300px]';
