// Version :011126 11:30
// File    :get-refresh-token.js
/**
 * ONE-TIME, run on your own computer (not on Render):
 *   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node get-refresh-token.js
 * Sign in as agentic.avai@gmail.com, approve, and copy the printed refresh token
 * into Render as GOOGLE_REFRESH_TOKEN.
 *
 * OAuth client type must be "Desktop app" (loopback redirect is allowed automatically).
 */
const http = require('http');
const { google } = require('googleapis');

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  process.exit(1);
}
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const oauth2 = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);

const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // forces a refresh token to be issued
  scope: [
    'https://www.googleapis.com/auth/drive',      // create folders, upload, copy shared files
    'https://www.googleapis.com/auth/gmail.send', // send confirmation codes
  ],
  login_hint: 'agentic.avai@gmail.com',
});

http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) return res.end();
  const code = new URL(req.url, REDIRECT).searchParams.get('code');
  try {
    const { tokens } = await oauth2.getToken(code);
    res.end('Done. Return to the terminal.');
    console.log('\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
  } catch (e) {
    res.end('Error: ' + e.message);
    console.error(e.message);
  }
  process.exit(0);
}).listen(PORT, () => console.log('Open this URL in your browser:\n\n' + url + '\n'));
