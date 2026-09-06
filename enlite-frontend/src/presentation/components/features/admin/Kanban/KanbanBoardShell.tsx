import { useState, type ReactNode } from 'react';
import {
  DndContext, DragEndEvent, DragOverlay, DragStartEvent,
  PointerSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core';
import { KanbanColumn } from './KanbanColumn';
import { DraggableCard } from './DraggableCard';

/** Uma coluna do board. `droppable=false` = coluna alimentada por outro sistema. */
export interface KanbanColumnSpec {
  id: string;
  title: string;
  /** classe de cor do bolinha do cabeçalho (ex.: 'bg-green-500'). */
  color: string;
  droppable?: boolean;
  /** Cabeçalho em tom de alerta (vermelho) — coluna que pede ação do operador. */
  alert?: boolean;
}

/** O que o board de negócio recebe quando um card é solto numa coluna válida. */
export interface KanbanDropEvent<T> {
  item: T;
  itemId: string;
  fromColumnId: string;
  toColumnId: string;
}

interface KanbanBoardShellProps<T> {
  columns: KanbanColumnSpec[];
  /** Itens de uma coluna. Chamada por coluna, na ordem de `columns`. */
  itemsOf: (columnId: string) => T[];
  getItemId: (item: T) => string;
  /** Bloqueia SÓ o arrasto do card (o conteúdo continua clicável). */
  isDragDisabled?: (item: T) => boolean;
  renderCard: (item: T, columnId: string) => ReactNode;
  /** Card "fantasma" sob o cursor. Sem isto, reusa `renderCard`. */
  renderDragOverlay?: (item: T, columnId: string) => ReactNode;
  /**
   * Só dispara para coluna `droppable`. Recebe a coluna de ORIGEM junto —
   * quem decide se soltar na própria coluna é no-op é o board de negócio,
   * porque a resposta muda por domínio (no funil de vaga, soltar em SELECTED
   * reabre o seletor de papel; no de pacientes, não faz nada).
   */
  onDrop: (event: KanbanDropEvent<T>) => void;
  /**
   * Chave de localStorage do colapso das colunas. **Sem ela não há botão de
   * colapsar** — é o que liga a funcionalidade para um board.
   */
  collapseStorageKey?: string;
  /**
   * Largura da coluna expandida. Default `w-[280px]` — dimensionado para o
   * funil de vagas, que tem 9 colunas e rola de qualquer jeito. Board com
   * poucas colunas deve passar um valor que caiba: medido em 30/08, o de
   * pacientes tinha 1096px úteis para 1156px de conteúdo (4x280 + 3x12) e a
   * 4ª coluna ficava 60px fora da tela, com o badge do caso pela metade.
   */
  columnWidthClass?: string;
  testId?: string;
}

/** Colunas colapsadas num trilho fino (estilo ClickUp), persistidas por board. */
function useCollapsedColumns(storageKey?: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (!storageKey) return new Set<string>();
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  function toggle(columnId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          // localStorage indisponível (modo privado etc.) — colapso só em memória.
        }
      }
      return next;
    });
  }

  return { collapsed, toggle };
}

/**
 * Motor compartilhado de kanban: dnd-kit (contexto, sensores, auto-scroll),
 * trilha de colunas, overlay de arrasto e colapso de coluna persistido.
 *
 * Existe porque o board do funil de vagas e o de pacientes tinham a MESMA
 * mecânica escrita duas vezes — e só uma das cópias ganhou o colapso de coluna.
 * Aqui a mecânica é única; cada board de negócio entra com suas colunas, seus
 * cards e o que fazer no drop.
 *
 * O que fica de fora de propósito: modais, regras de transição e chamadas de
 * API. Isto é a mesa, não o jogo.
 */
export function KanbanBoardShell<T>({
  columns,
  itemsOf,
  getItemId,
  isDragDisabled,
  renderCard,
  renderDragOverlay,
  onDrop,
  collapseStorageKey,
  columnWidthClass,
  testId = 'kanban-board',
}: KanbanBoardShellProps<T>): JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null);
  const { collapsed, toggle } = useCollapsedColumns(collapseStorageKey);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  /** Localiza o card arrastado e a coluna de onde ele saiu. */
  function locate(itemId: string): { item: T; columnId: string } | null {
    for (const col of columns) {
      const item = itemsOf(col.id).find((i) => getItemId(i) === itemId);
      if (item) return { item, columnId: col.id };
    }
    return null;
  }

  const active = activeId ? locate(activeId) : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const itemId = activeId;
    setActiveId(null);
    if (!itemId || !event.over) return;

    const toColumnId = String(event.over.id);
    // Coluna não-droppable nem chega aqui (useDroppable desabilitado), mas o
    // guard mantém a regra explícita numa fonte só — antes ela vivia duplicada
    // como um Set separado, que podia divergir da config das colunas.
    if (!columns.some((c) => c.id === toColumnId && c.droppable !== false)) return;

    const found = locate(itemId);
    if (!found) return;

    onDrop({ item: found.item, itemId, fromColumnId: found.columnId, toColumnId });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      autoScroll={{ threshold: { x: 0.2, y: 0 }, acceleration: 18 }}
    >
      <div data-testid={testId} className="flex gap-3 overflow-x-auto pb-4">
        {columns.map((col) => {
          const items = itemsOf(col.id);
          return (
            <KanbanColumn
              key={col.id}
              id={col.id}
              title={col.title}
              count={items.length}
              color={col.color}
              droppable={col.droppable !== false}
              alert={col.alert}
              dragActive={activeId !== null}
              collapsed={collapsed.has(col.id)}
              onToggleCollapse={collapseStorageKey ? () => toggle(col.id) : undefined}
              widthClass={columnWidthClass}
            >
              {items.map((item) => (
                <DraggableCard
                  key={getItemId(item)}
                  id={getItemId(item)}
                  disabled={isDragDisabled?.(item) ?? false}
                >
                  {renderCard(item, col.id)}
                </DraggableCard>
              ))}
            </KanbanColumn>
          );
        })}
      </div>

      <DragOverlay>
        {active ? (
          <div className="opacity-80 rotate-2">
            {(renderDragOverlay ?? renderCard)(active.item, active.columnId)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
