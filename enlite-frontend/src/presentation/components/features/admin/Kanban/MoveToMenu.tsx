import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightLeft, ChevronDown } from 'lucide-react';

/**
 * Destinos de movimentação MANUAL do card no funil. Espelha o `DROPPABLE_STAGES`
 * do KanbanBoard, menos REJECTED — a rejeição tem botão próprio ("Rechazar") que
 * abre o modal de motivo, então fica de fora do menu pra não duplicar o fluxo.
 */
const MOVE_TARGETS = ['INVITED', 'CONFIRMED', 'SELECTED'] as const;

/**
 * Mapeia o id da COLUNA onde o card está para o funnel stage efetivo, pra excluir
 * o destino atual do menu. INVITED+source='manual' renderiza na coluna INICIADO,
 * mas seu stage efetivo é INVITED — ver [[project_kanban_droppable_stages_sync]].
 */
function effectiveStage(columnId: string): string {
  return columnId === 'INICIADO' ? 'INVITED' : columnId;
}

interface MoveToMenuProps {
  /** Id da coluna onde o card está (prop `stage` do KanbanCard). */
  currentStage: string;
  /** Move o card para o stage escolhido (mesmo caminho do drag). */
  onMove: (targetStage: string) => void;
}

/**
 * Alternativa de clique ao arrasto: um botão "Mover a…" que abre um menu com as
 * colunas de destino válidas (excluindo a atual). Preciso em boards com muitas
 * colunas, onde acertar a coluna arrastando é difícil.
 *
 * D269: sem `funnel:write` este componente nem é montado — o `KanbanCard`
 * (chamador) decide isso, não passa `disabled` pra cá (ver `moveDisabled` em
 * `KanbanCard.tsx` — some, não desabilita).
 */
export function MoveToMenu({ currentStage, onMove }: MoveToMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = effectiveStage(currentStage);
  const targets = MOVE_TARGETS.filter((stage) => stage !== current);

  // Fecha ao clicar fora — sem isso o menu ficaria preso aberto no board.
  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  if (targets.length === 0) return null;

  return (
    <div ref={ref} className="mt-2" onClick={(e) => e.stopPropagation()}>
      <button
        data-testid="move-to-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="w-full flex items-center justify-between gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-slate-600 hover:bg-slate-100 hover:text-primary transition-colors border border-slate-200"
      >
        <span className="flex items-center gap-1">
          <ArrowRightLeft className="w-3 h-3" aria-hidden="true" />
          {t('admin.kanban.moveToButton')}
        </span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          data-testid="move-to-menu"
          role="menu"
          className="mt-1 flex flex-col gap-0.5 rounded-lg border border-slate-200 bg-white p-1 shadow-md"
        >
          {targets.map((stage) => (
            <button
              key={stage}
              data-testid={`move-to-option-${stage}`}
              role="menuitem"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onMove(stage);
              }}
              className="w-full text-left px-2 py-1 rounded-md text-[10px] font-medium text-slate-700 hover:bg-primary/10 hover:text-primary transition-colors"
            >
              {t(`admin.kanban.columns.${stage}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
