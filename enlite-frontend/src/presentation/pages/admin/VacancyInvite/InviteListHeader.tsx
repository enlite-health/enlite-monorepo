import { useTranslation } from 'react-i18next';
import { CircleCheck, Info } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { Switch } from '@presentation/components/atoms/Switch';
import { InviteStepCards } from './InviteStepCards';
import type { buildBoardView, StepId } from './inviteBoardModel';
import type { StepOutcome } from '@hooks/admin/useInviteSending';

type View = ReturnType<typeof buildBoardView>;

interface Props {
  view: View;
  docOnly: boolean;
  onSelectStep: (step: StepId) => void;
  onToggleAll: (select: boolean) => void;
  onDocOnly: (on: boolean) => void;
  /** F4 (E5.1–E5.3): o que saiu neste passo nesta visita; `null`/zeros = sem alerta. */
  outcome?: StepOutcome | null;
}

/** B.1–B.7 — frase-guia, nota do perfil, cartões e barra de ferramentas da lista. */
export function InviteListHeader({ view, docOnly, onSelectStep, onToggleAll, onDocOnly, outcome }: Props): JSX.Element {
  const { t } = useTranslation();
  const { title, selection, docs } = view;
  const titleText =
    title.kind === 'vacante'
      ? t('admin.vacancyInvite.stepTitle.vacante')
      : t(`admin.vacancyInvite.stepTitle.${title.kind}`, { min: title.min, max: title.max });

  return (
    <div data-testid="invite-list-header">
      {outcome && outcome.sent + outcome.failed > 0 && (
        <div className="px-6 pb-2 pt-4" data-testid="invite-sent-alert" data-failed={outcome.failed}>
          {/* ⚑8: texto #0A5540 sobre #E1F6EE (7,80:1); barra #0A5540 (o canvas: #0B5E45). Sem envio nenhum: tom âmbar. */}
          <div className={`rounded-2xl px-4 py-3 ${outcome.sent > 0 ? 'bg-[#E1F6EE] text-[#0A5540]' : 'bg-[#FFF4D6] text-[#5C3B00]'}`}>
            <Heading level={4} as="h3" weight="semibold" color="inherit" className="flex items-center gap-2 !text-sm !leading-5">
              {outcome.sent > 0 && <CircleCheck size={16} aria-hidden="true" />}
              {outcome.sent > 0 ? t('admin.vacancyInvite.sent.title', { count: outcome.sent }) : t('admin.vacancyInvite.sent.titleNone')}
            </Heading>
            <Text size="xs" color="inherit" className="mt-1">{t('admin.vacancyInvite.sent.text')}</Text>
            <div className="mt-2 flex items-center gap-3">
              <div role="progressbar" aria-valuemin={0} aria-valuemax={outcome.sent + outcome.failed} aria-valuenow={outcome.sent} className="h-2 flex-1 overflow-hidden rounded-full bg-white">
                <div className="h-full rounded-full bg-[#0A5540]" style={{ width: `${Math.round((outcome.sent / (outcome.sent + outcome.failed)) * 100)}%` }} />
              </div>
              <Text as="span" size="xs" weight="medium" color="inherit" data-testid="invite-sent-progress">
                {t('admin.vacancyInvite.sent.progress', { sent: outcome.sent, total: outcome.sent + outcome.failed })}
              </Text>
            </div>
            {outcome.failed > 0 && (
              <Text size="xs" weight="medium" color="inherit" className="mt-1.5" data-testid="invite-sent-failed">
                {t('admin.vacancyInvite.sent.failed', { count: outcome.failed })}
              </Text>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-3 border-b border-gray-300 px-6 pb-4 pt-5">
        <Text size="base" weight="medium" color="primary" data-testid="invite-guide" className="!leading-[22px]">
          {t(`admin.vacancyInvite.guide.${view.guide}`, { min: title.min, max: title.max })}
        </Text>
        {view.showProfileNote && (
          <div data-testid="invite-profile-note" className="flex items-center gap-1.5 text-primary/70">
            <Info size={14} aria-hidden="true" />
            <Text as="span" size="xs" color="inherit">{t('admin.vacancyInvite.profileNote')}</Text>
          </div>
        )}
        <InviteStepCards steps={view.steps} onSelect={onSelectStep} />
      </div>
      <div className="flex min-h-16 items-center gap-3 border-b border-gray-300 px-6 py-2.5">
        <Checkbox
          id="invite-select-all"
          data-testid="invite-select-all"
          label={t('admin.vacancyInvite.selection.all')}
          checked={selection.allChecked}
          disabled={selection.allDisabled}
          onChange={(e) => onToggleAll(e.target.checked)}
        />
        <div className="min-w-0 flex-1">
          <Heading level={4} as="h2" weight="semibold" color="primary" data-testid="invite-list-title" className="truncate !leading-6">
            {titleText}
          </Heading>
          <Text size="xs" color="inherit" data-testid="invite-docs-line" className="truncate whitespace-nowrap text-primary/70">
            {t(`admin.vacancyInvite.docs.${docs.mode}`, { complete: docs.complete, missing: docs.missing })}
          </Text>
        </div>
        <div data-testid="invite-doc-only" className="flex h-10 items-center rounded-[10px] border border-gray-600 px-2.5">
          <Switch checked={docOnly} onChange={onDocOnly} label={t('admin.vacancyInvite.docs.switch')} />
        </div>
        <Text as="span" size="sm" weight="medium" color="primary" data-testid="invite-counter">
          {selection.allInvited
            ? t('admin.vacancyInvite.selection.allInvited')
            : t('admin.vacancyInvite.selection.counter', { selected: selection.selected, pending: selection.pending })}
        </Text>
      </div>
    </div>
  );
}
