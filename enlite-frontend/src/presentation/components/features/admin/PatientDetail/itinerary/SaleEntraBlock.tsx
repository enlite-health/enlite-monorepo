import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { PersonAvatar } from '@presentation/components/atoms/PersonAvatar';
import { Text } from '@presentation/components/atoms/Text';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import type { AllocationOptionStatus as RoleStatus } from '@domain/entities/ServiceTeam';
import { workerLabel } from '../workerLabel';

/** Bolinha do papel (a MESMA convenção de `AllocationOptionStatus`: verde = em atendimento, azul = resposta rápida, sem bolinha = selecionado). */
const ROLE_DOT: Record<RoleStatus, string | null> = { IN_SERVICE: 'bg-green-600', QUICK_RESPONSE: 'bg-blue-600', SELECTED: null };

export interface SalePerson {
  workerId: string;
  displayName: string | null;
  /** Segunda linha de quem sai: o motivo ("Vacaciones"). */
  caption: string | null;
}

export interface EntraPerson {
  workerId: string;
  displayName: string | null;
  /** O papel de quem entra ("Respuesta rápida"), quando a tela o conhece. */
  role?: RoleStatus;
}

interface SaleEntraBlockProps {
  sale: SalePerson;
  /** `[]` = "Nadie todavía". */
  entra: EntraPerson[];
  /** Rótulos dos dias em que ninguém entra, já formatados ("lun 9") — vira "salvo lun 9: nadie". */
  uncoveredLabels?: string[];
  /** Presente = a linha mostra "Elegir quién entra" no campo Entra (sem substituto); o resumo do fluxo não passa. */
  onPick?: () => void;
  /** Passadas/desfeitas: o bloco esmaece. */
  dimmed?: boolean;
  /** `equal` = Sale e Entra do mesmo tamanho (a linha da lista, alinhada ao cabeçalho); `content` = Entra do tamanho do conteúdo (o resumo do modal, estreito). */
  columns?: 'equal' | 'content';
  'data-testid'?: string;
}

/**
 * O bloco SALE → ENTRA (spec 069, US6 aceite 8; mockups `b2c.png` e `modal-resumen.png`) — UM só, usado pela linha da aba
 * "Sustituciones" E pelo resumo do último passo do fluxo. O sentido NÃO depende só de cor: cada lado tem seta por ÍCONE (↓ sai, ↑ entra)
 * com `aria-label` "Sale"/"Entra"; a informação de "sem cobertura" aparece NO CAMPO Entra ("Nadie todavía" + "Elegir quién entra"),
 * nunca num selo à parte. Cores do mockup (`.ci2`): #7A0A1E/#FFE0E5 (9,0:1) e #064E24/#D3F0DF (≥ 7:1).
 */
export function SaleEntraBlock({ sale, entra, uncoveredLabels = [], onPick, dimmed = false, columns = 'equal', 'data-testid': testId }: SaleEntraBlockProps): JSX.Element {
  const { t } = useTranslation();
  const tb = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.saleEntra.${key}`, opts);
  const saleName = workerLabel(t, sale.workerId, sale.displayName);
  // A régua D269: sem a célula `patient_itinerary:update`, "Elegir quién entra" SOME (o campo segue dizendo "Nadie todavía").
  const { allowed: canPick } = useActionGate('patient_itinerary', 'update');
  const nobody = entra.length === 0;
  const entraNames = entra.map((p) => workerLabel(t, p.workerId, p.displayName)).join(', ');
  const first = entra[0];

  return (
    <div className={`grid ${columns === 'equal' ? 'grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)_28px_minmax(0,auto)]'} items-center gap-3 ${dimmed ? 'opacity-70' : ''}`} data-testid={testId}>
      <div className="flex items-center gap-2 min-w-0" data-testid={testId ? `${testId}-sale` : undefined}>
        <span role="img" aria-label={tb('sale')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#FFE0E5] text-[#7A0A1E]">
          <ArrowDown size={16} aria-hidden="true" />
        </span>
        <PersonAvatar uid={sale.workerId} name={saleName} size={32} />
        <div className="flex min-w-0 flex-col">
          <Text as="span" size="sm" weight="semibold" color="primary" className="break-words">
            {saleName}
          </Text>
          {sale.caption && (
            <Text as="span" size="xs" color="tertiary">
              {sale.caption}
            </Text>
          )}
        </div>
      </div>

      <ArrowRight size={16} className="justify-self-center text-[#374151]" aria-hidden="true" />

      <div className="flex items-center gap-2 min-w-0" data-testid={testId ? `${testId}-entra` : undefined}>
        <span
          role="img"
          aria-label={tb('enters')}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${nobody ? 'bg-[#E8E8E8] text-[#4A4A4A]' : 'bg-[#D3F0DF] text-[#064E24]'}`}
        >
          <ArrowUp size={16} aria-hidden="true" />
        </span>
        {nobody ? (
          <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-full border-2 border-dashed border-gray-800" />
        ) : (
          <PersonAvatar uid={first.workerId} name={workerLabel(t, first.workerId, first.displayName)} size={32} />
        )}
        <div className="flex min-w-0 flex-col">
          {nobody ? (
            <>
              <Text as="span" size="sm" weight="semibold" color="inherit" className="text-red-900">
                {tb('nobodyYet')}
              </Text>
              {onPick && canPick && (
                <button type="button" onClick={onPick} className="self-start underline" data-testid={testId ? `${testId}-elegir` : undefined}>
                  <Text as="span" size="xs" weight="semibold" color="primary">
                    {tb('pick')}
                  </Text>
                </button>
              )}
            </>
          ) : (
            <>
              <Text as="span" size="sm" weight="semibold" color="primary" className="break-words">
                {entraNames}
              </Text>
              {first.role && entra.length === 1 && (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap" data-testid={testId ? `${testId}-papel` : undefined} data-role={first.role}>
                  {ROLE_DOT[first.role] && <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${ROLE_DOT[first.role]}`} />}
                  <Text as="span" size="xs" color="tertiary">
                    {tb(`roles.${first.role}`)}
                  </Text>
                </span>
              )}
              {uncoveredLabels.length > 0 && (
                <Text as="span" size="xs" weight="semibold" color="inherit" className="text-red-900" data-testid={testId ? `${testId}-salvo` : undefined}>
                  {tb('except', { days: uncoveredLabels.join(', ') })}
                </Text>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
