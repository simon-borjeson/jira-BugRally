import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// "Sign in with Atlassian" (OAuth 2.0 authorization code / 3LO).
// Each browser gets its own session, so everyone acts in Jira as themselves.
// Sessions (with their tokens) are kept in data/sessions.json so a restart doesn't sign people out.

const AUTH = process.env.ATLASSIAN_AUTH_URL || 'https://auth.atlassian.com';
const API = process.env.ATLASSIAN_API_URL || 'https://api.atlassian.com';
export const OAUTH_SCOPES = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'];
// Jira Software (boards and ranking) only accepts granular scopes. They must also be added to the app
// in the developer console, or Atlassian refuses the sign-in.
export const SOFTWARE_SCOPES = [
  'read:board-scope:jira-software',
  'read:board-scope.admin:jira-software',
  'write:issue:jira-software',
  'read:project:jira',
];
const IDLE_LIMIT = 90 * 24 * 3600 * 1000;

export function createOAuth({ file, getConfig }) {
  let sessions = {};
  try {
    if (fs.existsSync(file)) sessions = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`Could not read ${file}: ${e.message}`);
  }
  const refreshing = new Map();

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sessions, null, 2));
  };

  // Only a real rejection (bad or expired grant) means "sign in again".
  // Slow answers, timeouts and server hiccups are temporary: the session is kept and the call can be retried.
  async function tokenCall(body, attempt = 1) {
    const { clientId, clientSecret } = getConfig();
    let res;
    try {
      res = await fetch(`${AUTH}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...body }),
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) {
      if (attempt < 2) return tokenCall(body, attempt + 1);
      const why = e.name === 'TimeoutError' ? 'it took too long to answer' : e.cause?.code || e.message;
      throw Object.assign(new Error(`Atlassian's sign-in service is slow right now (${why}). Please try again.`), { status: 503 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const rejected = res.status === 401 || res.status === 403 || ['invalid_grant', 'unauthorized_client', 'access_denied', 'invalid_client'].includes(data.error);
      if (!rejected && attempt < 2) return tokenCall(body, attempt + 1);
      const msg = rejected
        ? `Atlassian sign-in failed: ${data.error_description || data.error || res.status}`
        : "Atlassian's sign-in service is slow or unavailable right now. You're still signed in; please try again in a moment.";
      throw Object.assign(new Error(msg), { status: rejected ? 401 : 503, needsLogin: rejected });
    }
    return data;
  }

  const apply = (s, t) => {
    s.accessToken = t.access_token;
    if (t.refresh_token) s.refreshToken = t.refresh_token;
    s.expiresAt = Date.now() + (t.expires_in || 3600) * 1000;
  };

  // Refresh tokens rotate, so make sure only one refresh per session runs at a time.
  async function freshToken(sid, force = false) {
    const s = sessions[sid];
    if (!s) throw Object.assign(new Error('Please sign in with Atlassian.'), { status: 401, needsLogin: true });
    s.lastUsed = Date.now();
    if (!force && s.expiresAt - 5 * 60000 > Date.now()) return s.accessToken;
    if (!s.refreshToken) {
      delete sessions[sid];
      save();
      throw Object.assign(new Error('Your Atlassian sign-in has expired. Please sign in again.'), { status: 401, needsLogin: true });
    }
    if (!refreshing.has(sid)) {
      refreshing.set(
        sid,
        tokenCall({ grant_type: 'refresh_token', refresh_token: s.refreshToken })
          .then((t) => {
            apply(s, t);
            save();
          })
          .catch((e) => {
            // Keep the session unless Atlassian really rejected it.
            if (e.needsLogin) {
              delete sessions[sid];
              save();
            }
            throw e;
          })
          .finally(() => refreshing.delete(sid)),
      );
    }
    await refreshing.get(sid);
    return sessions[sid].accessToken;
  }

  // Drop sessions nobody has used for a long time.
  const now = Date.now();
  for (const [sid, s] of Object.entries(sessions)) if (now - (s.lastUsed || 0) > IDLE_LIMIT) delete sessions[sid];

  return {
    authorizeUrl({ redirectUri, state }) {
      const { clientId, softwareScopes } = getConfig();
      const scopes = softwareScopes ? [...OAUTH_SCOPES, ...SOFTWARE_SCOPES] : OAUTH_SCOPES;
      const q = new URLSearchParams({
        audience: 'api.atlassian.com',
        client_id: clientId,
        scope: scopes.join(' '),
        redirect_uri: redirectUri,
        state,
        response_type: 'code',
        prompt: 'consent',
      });
      return `${AUTH}/authorize?${q}`;
    },

    async finishLogin({ code, redirectUri }) {
      const { siteUrl } = getConfig();
      const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      const res = await fetch(`${API}/oauth/token/accessible-resources`, {
        headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' },
      });
      const sites = res.ok ? await res.json() : [];
      const want = siteUrl ? new URL(siteUrl).origin : null;
      const site = want ? sites.find((x) => new URL(x.url).origin === want) : sites[0];
      if (!site) {
        throw Object.assign(
          new Error(
            want
              ? `Your Atlassian account didn't give Bug Rally access to ${want}. Sign in again and pick that site on the consent screen.`
              : 'Your Atlassian account has no Jira sites that Bug Rally can use.',
          ),
          { status: 403 },
        );
      }
      const me = await fetch(`${API}/ex/jira/${site.id}/rest/api/3/myself`, {
        headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' },
      }).then((r) => (r.ok ? r.json() : {}));
      const sid = crypto.randomBytes(32).toString('hex');
      const s = { cloudId: site.id, site: new URL(site.url).origin, user: me.displayName || 'You', email: me.emailAddress || '', lastUsed: Date.now() };
      apply(s, t);
      sessions[sid] = s;
      save();
      return sid;
    },

    getSession(sid) {
      return sid && sessions[sid] ? sessions[sid] : null;
    },

    connectionFor(sid) {
      const s = sessions[sid];
      return {
        apiRoot: `${API}/ex/jira/${s.cloudId}`,
        site: s.site,
        email: s.email,
        authKind: 'oauth',
        // force = true renews the access token even if it looks valid (used once after a 401).
        getAuth: async (force) => `Bearer ${await freshToken(sid, force)}`,
      };
    },

    destroy(sid) {
      if (sessions[sid]) {
        delete sessions[sid];
        save();
      }
    },

    count() {
      return Object.keys(sessions).length;
    },

    destroyAll() {
      sessions = {};
      save();
    },
  };
}
