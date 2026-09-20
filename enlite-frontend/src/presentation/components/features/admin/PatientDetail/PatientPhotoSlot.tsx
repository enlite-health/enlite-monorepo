/**
 * PatientPhotoSlot — slot da foto no cabeçalho da ficha (spec 018, PR-4, task 4.10; contrato
 * `contracts/patient-header-and-photo.md` §Foto). Substitui o círculo cinza estático que a
 * `PatientIdentityCard` tinha (linhas ~188-191 antes desta mudança). Extraído para arquivo
 * próprio: a `PatientIdentityCard` já estava no teto de 400 linhas do frontend.
 *
 * Regras do contrato seguidas aqui:
 *  - `<img data-clarity-mask="True" referrerPolicy="no-referrer">` (linha 59) — a URL assinada
 *    nunca vai a cache/log e a máscara do Clarity cobre o rosto.
 *  - Upload/remover só aparecem com `patient_identity:write` (`ActionButton`, `mode='hide'`
 *    default — D269, o botão SOME sem a célula, não fica desabilitado).
 *  - Visualização (buscar a signed URL) só roda com `patient_identity:read` — sem a célula, o
 *    slot mostra o círculo cinza padrão, nunca tenta o GET (evitaria um 403 previsível).
 *  - Sem gate de consentimento no upload (D335, 14/09): a rota aceita o arquivo direto.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Upload, Trash2 } from 'lucide-react';
import { AdminApiService, ApiError } from '@infrastructure/http/AdminApiService';
import { ActionButton } from '@presentation/components/features/access';
import { useCellAccess } from '@presentation/hooks/useCellAccess';
import { Text } from '@presentation/components/atoms/Text';
import { PatientPhotoRemoveConfirm } from './PatientPhotoRemoveConfirm';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png'];
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — mesmo teto do contrato (linha 53).

interface Props {
  patientId: string;
  hasPhoto: boolean | null | undefined;
  /** Chamado depois de upload/remoção com sucesso — o pai refaz o fetch da ficha (mesmo padrão de `onSaved`). */
  onChanged?: () => void;
}

export function PatientPhotoSlot({ patientId, hasPhoto, onChanged }: Props): JSX.Element {
  const { t } = useTranslation();
  const tp = (k: string): string => t(`admin.patients.detail.identityCard.photo.${k}`);
  const { canRead } = useCellAccess('patient_identity');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Incrementado após upload/remoção com sucesso, para refazer o GET da signed URL — nunca é lido
  // pelo JSX, só existe para o `useEffect` abaixo refirar (não pode ser derivado do próprio efeito
  // como estado-gate, senão a limpeza do efeito corre ANTES da promise resolver — bug real medido
  // aqui: o `cancelled` da própria run cancelava o resultado que ela mesma pediu).
  const [refreshToken, setRefreshToken] = useState(0);

  const shouldShowPhoto = canRead && hasPhoto === true;

  // Busca a signed URL sempre que precisa exibir (troca de paciente ou `refreshToken` mudou).
  useEffect(() => {
    if (!shouldShowPhoto) {
      setPhotoUrl(null);
      return;
    }
    let cancelled = false;
    AdminApiService.getPatientPhotoUrl(patientId)
      .then((res) => { if (!cancelled) setPhotoUrl(res.url); })
      .catch(() => { if (!cancelled) setPhotoUrl(null); });
    return () => { cancelled = true; };
  }, [shouldShowPhoto, patientId, refreshToken]);

  const validateFile = (file: File): string | null => {
    if (!ACCEPTED_TYPES.includes(file.type)) return tp('errorInvalidType');
    if (file.size > MAX_BYTES) return tp('errorTooLarge');
    return null;
  };

  const handleFileChosen = async (file: File) => {
    setError(null);
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }
    setUploading(true);
    try {
      await AdminApiService.uploadPatientPhoto(patientId, file);
      setRefreshToken((n) => n + 1);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : tp('errorUploadGeneric'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await AdminApiService.deletePatientPhoto(patientId);
      setPhotoUrl(null);
      setConfirmingRemove(false);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : tp('errorRemoveGeneric'));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex items-start gap-3" data-testid="patient-photo-slot">
      <div className="w-14 h-14 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 shrink-0 overflow-hidden" data-clarity-mask="True">
        {shouldShowPhoto && photoUrl ? (
          <img
            src={photoUrl}
            alt={tp('altText')}
            referrerPolicy="no-referrer"
            data-clarity-mask="True"
            className="w-full h-full object-cover"
            data-testid="patient-photo-image"
          />
        ) : (
          <User className="w-8 h-8" data-testid="patient-photo-placeholder" />
        )}
      </div>
      <div className="flex flex-col gap-1 pt-1">
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            className="hidden"
            data-testid="patient-photo-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileChosen(file);
            }}
          />
          <ActionButton
            resource="patient_identity"
            action="create"
            variant="outline"
            size="sm"
            isLoading={uploading}
            onClick={() => fileInputRef.current?.click()}
            data-testid="patient-photo-upload-btn"
          >
            <Upload className="w-3.5 h-3.5 mr-1.5" />
            {tp(hasPhoto ? 'changeButton' : 'uploadButton')}
          </ActionButton>
          {hasPhoto === true && (
            <ActionButton
              resource="patient_identity"
              action="update"
              variant="outline"
              size="sm"
              onClick={() => setConfirmingRemove(true)}
              data-testid="patient-photo-remove-btn"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {tp('removeButton')}
            </ActionButton>
          )}
        </div>
        {error && (
          <Text size="xs" role="alert" className="text-red-600" data-testid="patient-photo-error">
            {error}
          </Text>
        )}
      </div>
      {confirmingRemove && (
        <PatientPhotoRemoveConfirm
          busy={removing}
          onConfirm={handleRemove}
          onClose={() => setConfirmingRemove(false)}
        />
      )}
    </div>
  );
}
