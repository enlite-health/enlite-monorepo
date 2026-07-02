import type { ConsentPageParams } from '../../application/oauth/EnliteOAuthProvider';

export interface ConsentPageConfig {
  firebaseApiKey: string;
  firebaseAuthDomain: string;
}

/**
 * Página de consent do OAuth do MCP (servida pelo Express — precedente:
 * Swagger UI). Login Google via Firebase Web SDK (mesma identidade do painel
 * admin); o idToken vai pro POST /oauth/consent junto com o requestContext
 * assinado, e o server responde com a redirect URL (code + state).
 */
export function renderConsentPage(config: ConsentPageConfig, params: ConsentPageParams): string {
  const clientName = escapeHtml(params.clientName ?? 'Claude');
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conectar ${clientName} a Enlite</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #f6f8fa;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #e1e4e8; border-radius: 12px; padding: 40px;
          max-width: 420px; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,.06); }
  h1 { font-size: 20px; margin: 0 0 8px; color: #1f2328; }
  p  { color: #57606a; font-size: 14px; line-height: 1.5; }
  .scope { background: #f6f8fa; border-radius: 8px; padding: 10px 14px; font-size: 13px;
           color: #57606a; margin: 16px 0; text-align: left; }
  button { background: #1a7f37; color: #fff; border: 0; border-radius: 8px; padding: 12px 24px;
           font-size: 15px; cursor: pointer; width: 100%; }
  button:disabled { opacity: .6; cursor: wait; }
  #error { color: #cf222e; font-size: 13px; margin-top: 12px; min-height: 18px; }
</style>
</head>
<body>
<div class="card">
  <h1>Conectar ${clientName} a Enlite</h1>
  <p>Iniciá sesión con tu cuenta de staff de Enlite para autorizar el acceso.</p>
  <div class="scope">Acceso de <strong>solo lectura</strong>: perfil, documentos, vacantes y entrevista de prestadores.</div>
  <button id="signin">Continuar con Google</button>
  <div id="error"></div>
</div>
<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
<script>
  firebase.initializeApp({
    apiKey: ${JSON.stringify(config.firebaseApiKey)},
    authDomain: ${JSON.stringify(config.firebaseAuthDomain)},
  });
  var requestContext = ${JSON.stringify(params.requestContext)};
  var btn = document.getElementById('signin');
  var errEl = document.getElementById('error');
  btn.addEventListener('click', function () {
    btn.disabled = true;
    errEl.textContent = '';
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    firebase.auth().signInWithPopup(provider)
      .then(function (result) { return result.user.getIdToken(); })
      .then(function (idToken) {
        return fetch('/oauth/consent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: idToken, requestContext: requestContext }),
        });
      })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'No autorizado');
          window.location.assign(body.redirectUrl);
        });
      })
      .catch(function (err) {
        btn.disabled = false;
        errEl.textContent = err && err.message ? err.message : 'Error al iniciar sesión';
      });
  });
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
