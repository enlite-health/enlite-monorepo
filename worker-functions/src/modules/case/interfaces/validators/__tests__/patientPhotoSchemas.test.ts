import { patientIdParamsSchema } from '../patientPhotoSchemas';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Documento/consentimento de imagem, que este arquivo também cobria, foram REMOVIDOS por completo
// (fix/018-remover-documentos-consentimento) — só o schema de foto fica.
describe('patientPhotoSchemas (spec 018 PR-4)', () => {
  it('patientIdParamsSchema — UUID válido passa, resto falha', () => {
    expect(patientIdParamsSchema.safeParse({ id: PID }).success).toBe(true);
    expect(patientIdParamsSchema.safeParse({ id: 'x' }).success).toBe(false);
  });
});
