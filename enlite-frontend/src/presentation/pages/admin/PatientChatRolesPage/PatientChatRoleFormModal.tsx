/**
 * PatientChatRoleFormModal — side-sheet (padrão do DS) para criar ou editar um
 * papel do catálogo de grupos de WhatsApp do paciente.
 *
 * O `code` é editável só na CRIAÇÃO. Trocá-lo depois renomearia a chave de join
 * da auditoria de informes sem que ninguém percebesse — o backend nem aceita o
 * campo no PATCH. Para "renomear", cria-se outro papel.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { PatientChatRoleSpec } from '@domain/value-objects/patientChatRole';
import { isPatientChatRoleCode, PATIENT_CHAT_ROLE_MAX_LENGTH } from '@domain/value-objects/patientChatRole';
import { Heading } from '@presentation/components/atoms/Heading';
import { Label } from '@presentation/components/atoms/Label';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { refusalMessage } from './refusalMessage';

export interface ChatRoleFormData {
  code: string;
  labelEs: string;
  labelPtBr: string;
  isExclusive: boolean;
  displayOrder: number;
  matchKeywords: string[];
}

interface Props {
  role: PatientChatRoleSpec | null;
  /** Quantos pacientes usam este papel hoje — some no modo criação. */
  usageCount?: number;
  onSave: (data: ChatRoleFormData) => Promise<void>;
  onClose: () => void;
}

export function PatientChatRoleFormModal({ role, usageCount, onSave, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const tr = (k: string, o?: Record<string, unknown>) => t(`admin.patientChatRoles.${k}`, o ?? {});

  const isEdit = role !== null;
  const [code, setCode] = useState(role?.code ?? '');
  const [labelEs, setLabelEs] = useState(role?.labelEs ?? '');
  const [labelPtBr, setLabelPtBr] = useState(role?.labelPtBr ?? '');
  const [isExclusive, setIsExclusive] = useState(role?.isExclusive ?? true);
  const [displayOrder, setDisplayOrder] = useState(String(role?.displayOrder ?? 0));
  const [keywords, setKeywords] = useState((role?.matchKeywords ?? []).join(', '));
  const [isLoading, setIsLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [show, setShow] = useState(false);

  const inputClass =
    'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary focus:border-primary outline-none';

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function handleClose(): void {
    setShow(false);
    setTimeout(onClose, 300);
  }

  const codeInvalid = !isEdit && code.trim() !== '' && !isPatientChatRoleCode(code.trim());
  const canSubmit =
    labelEs.trim() !== '' &&
    labelPtBr.trim() !== '' &&
    (isEdit || (code.trim() !== '' && !codeInvalid));

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    try {
      setIsLoading(true);
      setSaveError('');
      await onSave({
        code: code.trim(),
        labelEs: labelEs.trim(),
        labelPtBr: labelPtBr.trim(),
        isExclusive,
        displayOrder: Number(displayOrder) || 0,
        matchKeywords: keywords
          .split(',')
          .map(w => w.trim())
          .filter(Boolean),
      });
    } catch (err: unknown) {
      // Traduzida, mas COM a contagem que o backend mandou ("são 5 pacientes"):
      // é o número que decide o que a pessoa faz em seguida.
      setSaveError(refusalMessage(err, t) || tr('saveError'));
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${
          show ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={handleClose}
        data-testid="chat-role-form-backdrop"
      />

      <div
        role="dialog"
        aria-modal="true"
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-md bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${
          show ? 'translate-x-0' : 'translate-x-full'
        }`}
        data-testid="chat-role-form-modal"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <Heading level={2} weight="semibold" color="primary">
            {isEdit ? tr('editRole') : tr('newRole')}
          </Heading>
          <button
            type="button"
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded cursor-pointer"
            aria-label={tr('cancel')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-8 space-y-6">
          <div>
            <Label htmlFor="chat-role-code">{tr('code')}</Label>
            <input
              id="chat-role-code"
              type="text"
              className={`${inputClass} font-mono ${isEdit ? 'bg-gray-50 text-gray-500' : ''}`}
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="HEALTH_PLAN"
              maxLength={PATIENT_CHAT_ROLE_MAX_LENGTH}
              disabled={isEdit}
              data-testid="chat-role-code-input"
            />
            <Text size="xs" color="muted">
              {isEdit ? tr('codeImmutable') : tr('codeHelp')}
            </Text>
            {codeInvalid && (
              <span data-testid="chat-role-code-error">
                <Text size="xs" className="text-red-600">{tr('codeInvalid')}</Text>
              </span>
            )}
          </div>

          <div>
            <Label htmlFor="chat-role-label-es">{tr('labelEs')}</Label>
            <input
              id="chat-role-label-es"
              type="text"
              className={inputClass}
              value={labelEs}
              onChange={e => setLabelEs(e.target.value)}
              placeholder="Grupo de la obra social"
              maxLength={120}
              data-testid="chat-role-label-es-input"
            />
          </div>

          <div>
            <Label htmlFor="chat-role-label-pt">{tr('labelPtBr')}</Label>
            <input
              id="chat-role-label-pt"
              type="text"
              className={inputClass}
              value={labelPtBr}
              onChange={e => setLabelPtBr(e.target.value)}
              placeholder="Grupo do plano de saúde"
              maxLength={120}
              data-testid="chat-role-label-pt-input"
            />
            <Text size="xs" color="muted">{tr('labelsHelp')}</Text>
          </div>

          <div>
            <Checkbox
              id="chat-role-exclusive"
              checked={isExclusive}
              onChange={e => setIsExclusive(e.target.checked)}
              label={tr('exclusive')}
              data-testid="chat-role-exclusive-checkbox"
            />
            <Text size="xs" color="muted">{tr('exclusiveHelp')}</Text>
            {isEdit && role && !role.isExclusive && isExclusive && (usageCount ?? 0) > 0 && (
              <div
                className="mt-2 border border-amber-400 bg-amber-50 rounded-lg px-3 py-2"
                role="alert"
                data-testid="chat-role-exclusive-warning"
              >
                <Text size="xs" className="text-amber-800">
                  {tr('exclusiveWarning', { count: usageCount })}
                </Text>
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="chat-role-order">{tr('displayOrder')}</Label>
            <input
              id="chat-role-order"
              type="number"
              min={0}
              max={9999}
              className={inputClass}
              value={displayOrder}
              onChange={e => setDisplayOrder(e.target.value)}
              data-testid="chat-role-order-input"
            />
          </div>

          <div>
            <Label htmlFor="chat-role-keywords">{tr('matchKeywords')}</Label>
            <input
              id="chat-role-keywords"
              type="text"
              className={inputClass}
              value={keywords}
              onChange={e => setKeywords(e.target.value)}
              placeholder="flia, familia, family"
              data-testid="chat-role-keywords-input"
            />
            <Text size="xs" color="muted">{tr('matchKeywordsHelp')}</Text>
          </div>

          {saveError && (
            <div
              className="border border-red-300 bg-red-50 rounded-lg px-3 py-2"
              role="alert"
              data-testid="chat-role-form-error"
            >
              <Text size="sm" className="text-red-700">{saveError}</Text>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-8 py-5 border-t border-slate-100 shrink-0">
          <Button type="button" variant="outline" size="md" onClick={handleClose}>
            {tr('cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={handleSubmit}
            isLoading={isLoading}
            disabled={!canSubmit}
            data-testid="chat-role-save"
          >
            {tr('save')}
          </Button>
        </div>
      </div>
    </>
  );
}
