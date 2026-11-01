// Version :011126 11:30
// File    :lib/connect.js
/**
 * One-time "Connect Google" flow, run on the live Render app.
 *
 *   https://<app>/admin/connect   -> Google sign-in (as agentic.avai@gmail.com)
 *   https://<app>/admin/oauth2callback -> shows the refresh token to paste into Render
 *
 * Uses the SAME GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET that the app runs with,
 * so the token can never belong to a different client.
 * Only shows a token if the signed-in account is ADMIN_EMAIL.
 *
 * Google Cloud -> Clients -> Vouching -> Authorized redirect URIs must include:
 *   https://avatar-vouching.onrender.com/admin/oauth2callback
 */
const crypto = require('crypto');
const { google } = require('googleapis');

const env = (k) => String(process.env[k] || '').replace(/\s+/g, '');
const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.send'];
const states = new Map(); // state -> expiry

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font-family:Arial,sans-serif;background:#f0e8d8;color:#3a2010;margin:0}
header{background:#3d2314;color:#FFD700;padding:20px;text-align:center;font-size:1.3rem;font-weight:bold}
main{max-width:760px;margin:24px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 4px 20px rgba(0,0,0,.1)}
textarea{width:100%;height:90px;font-family:monospace;font-size:.85rem;padding:10px;box-sizing:border-box}
button{background:#3d2314;color:#FFD700;border:0;border-radius:8px;padding:10px 20px;font-weight:bold;cursor:pointer;margin-top:10px}
.ok{color:#2f6b2f}.err{color:#a3271b}code{background:#f7edd8;padding:1px 5px;border-radius:4px}
</style></head><body><header>AVAG.AI — Connect Google</header><main>${body}</main></body></html>`;

function mount(app) {
  const client = (req) =>
    new google.auth.OAuth2(env('GOOGLE_CLIENT_ID'), env('GOOGLE_CLIENT_SECRET'),
      `https://${req.get('host')}/admin/oauth2callback`);

  app.get('/admin/connect', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    states.set(state, Date.now() + 10 * 60 * 1000);
    const url = client(req).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES,
      state,
      login_hint: process.env.ADMIN_EMAIL || 'agentic.avai@gmail.com',
    });
    res.redirect(url);
  });

  app.get('/admin/oauth2callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(page('Error', `<p class="err">Google returned: <b>${String(error).replace(/[<>&]/g, '')}</b></p>`));
    const exp = states.get(state);
    states.delete(state);
    if (!exp || exp < Date.now()) return res.status(400).send(page('Expired', '<p class="err">Link expired. <a href="/admin/connect">Start again</a>.</p>'));

    try {
      const oauth = client(req);
      const { tokens } = await oauth.getToken(code);
      oauth.setCredentials(tokens);
      const about = await google.drive({ version: 'v3', auth: oauth }).about.get({ fields: 'user(emailAddress)' });
      const email = (about.data.user.emailAddress || '').toLowerCase();
      const admin = (process.env.ADMIN_EMAIL || 'agentic.avai@gmail.com').toLowerCase();
      if (email !== admin) {
        return res.status(403).send(page('Wrong account', `<p class="err">Signed in as <b>${email}</b>. Please <a href="/admin/connect">try again</a> and choose <b>${admin}</b>.</p>`));
      }
      if (!tokens.refresh_token) {
        return res.send(page('No token', `<p class="err">Google did not return a refresh token.</p>
          <p>Go to <a href="https://myaccount.google.com/connections" target="_blank">myaccount.google.com/connections</a>, remove <b>AVAG.AI Agent Services</b>, then <a href="/admin/connect">connect again</a>.</p>`));
      }
      const granted = (tokens.scope || '').split(' ');
      const missing = SCOPES.filter((s) => !granted.includes(s));
      res.set('Cache-Control', 'no-store').send(page('Connected', `
        <p class="ok"><b>✔ Connected as ${email}</b></p>
        ${missing.length ? `<p class="err">Missing permission: ${missing.join(', ')} — <a href="/admin/connect">redo</a> and tick both boxes.</p>` : '<p class="ok">✔ Drive + Gmail send granted</p>'}
        <p><b>Refresh token</b> — copy into Render → Environment → <code>GOOGLE_REFRESH_TOKEN</code> → Save Changes:</p>
        <textarea id="t" readonly>${tokens.refresh_token}</textarea>
        <button onclick="navigator.clipboard.writeText(document.getElementById('t').value);this.textContent='Copied ✔'">Copy</button>
        <p style="font-size:.85rem;color:#6b4a35;margin-top:18px">This page is not stored. Close it after copying. After Render redeploys, check <a href="/healthz/google">/healthz/google</a> shows <code>"ok": true</code>.</p>`));
    } catch (e) {
      const code = e.response?.data?.error || e.message;
      res.status(500).send(page('Error', `<p class="err">Token exchange failed: <b>${String(code).replace(/[<>&]/g, '')}</b></p>
        <p>If it says <code>redirect_uri_mismatch</code>: add <code>https://${req.get('host')}/admin/oauth2callback</code> to the OAuth client's Authorized redirect URIs, wait 5 minutes, retry.</p>
        <p>If it says <code>invalid_client</code>: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in Render are wrong.</p>`));
    }
  });
}

module.exports = { mount };
