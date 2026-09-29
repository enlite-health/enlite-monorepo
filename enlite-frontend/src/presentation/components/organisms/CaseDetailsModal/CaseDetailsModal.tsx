import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

interface CaseDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  caseData: any;
}

export function CaseDetailsModal({ isOpen, onClose, caseData }: CaseDetailsModalProps): JSX.Element | null {
  const { t } = useTranslation();

  if (!isOpen || !caseData) return null;

  const { caseInfo, metrics, publicationsHistory } = caseData;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto m-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
          <Heading level={2} weight="semibold">
            {t('admin.recruitment.caseDetails')} {caseInfo?.case_number}
          </Heading>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <X size={24} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Text size="sm" weight="semibold" color="muted">
                {t('admin.recruitment.status')}
              </Text>
              <Text size="sm">{caseInfo?.clickup_status || '-'}</Text>
            </div>
            <div>
              <Text size="sm" weight="semibold" color="muted">
                {t('admin.recruitment.priority')}
              </Text>
              <Text size="sm">{caseInfo?.clickup_priority || '-'}</Text>
            </div>
            <div>
              <Text size="sm" weight="semibold" color="muted">
                {t('admin.recruitment.diagnosis')}
              </Text>
              <Text size="sm">{caseInfo?.diagnosis || '-'}</Text>
            </div>
            <div>
              <Text size="sm" weight="semibold" color="muted">
                {t('admin.recruitment.zone')}
              </Text>
              <Text size="sm">{caseInfo?.patient_zone || '-'}</Text>
            </div>
          </div>

          <div>
            <Heading level={3} weight="semibold" className="mb-3">
              {t('admin.recruitment.metrics')}
            </Heading>
            <div className="grid grid-cols-4 gap-4">
              <div className="bg-blue-50 p-4 rounded-lg">
                <Text size="sm" color="muted">
                  {t('admin.recruitment.postulados')}
                </Text>
                <Heading level={2} weight="bold" color="inherit" className="text-blue-600">
                  {metrics?.postuladosInTalentum || 0}
                </Heading>
              </div>
              <div className="bg-green-50 p-4 rounded-lg">
                <Text size="sm" color="muted">
                  {t('admin.recruitment.seleccionados')}
                </Text>
                <Heading level={2} weight="bold" color="inherit" className="text-green-600">
                  {metrics?.seleccionados || 0}
                </Heading>
              </div>
              <div className="bg-yellow-50 p-4 rounded-lg">
                <Text size="sm" color="muted">
                  {t('admin.recruitment.reemplazos')}
                </Text>
                <Heading level={2} weight="bold" color="inherit" className="text-yellow-600">
                  {metrics?.reemplazos || 0}
                </Heading>
              </div>
              <div className="bg-purple-50 p-4 rounded-lg">
                <Text size="sm" color="muted">
                  {t('admin.recruitment.invitados')}
                </Text>
                <Heading level={2} weight="bold" color="inherit" className="text-purple-600">
                  {metrics?.invitados || 0}
                </Heading>
              </div>
            </div>
          </div>

          {publicationsHistory && publicationsHistory.length > 0 && (
            <div>
              <Heading level={3} weight="semibold" className="mb-3">
                {t('admin.recruitment.publicationsHistory')}
              </Heading>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {publicationsHistory.map((pub: any, idx: number) => (
                  <div key={idx} className="border-l-4 border-blue-500 pl-4 py-2">
                    <div className="flex justify-between">
                      <Text size="sm" weight="semibold">{pub.channel}</Text>
                      <Text size="sm" color="muted">
                        {new Date(pub.published_at).toLocaleDateString()}
                      </Text>
                    </div>
                    {pub.recruiter_name && (
                      <Text size="sm" color="muted">
                        {pub.recruiter_name}
                      </Text>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-gray-50 px-6 py-4 border-t flex justify-end">
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  );
}
