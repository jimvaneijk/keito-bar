// Minimal Jira Cloud REST client (main process only).
// Auth: Basic base64(email:API token) — token from id.atlassian.com → Security → API tokens.

class JiraError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'JiraError';
    this.kind = kind;
    this.status = status;
  }
}

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/i;

function normalizeSite(input) {
  let s = String(input || '').trim();
  if (!s) throw new JiraError('validation', 'Vul je Jira-adres in, bijv. 23g.atlassian.net.');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const url = new URL(s);
  if (url.protocol !== 'https:') throw new JiraError('validation', 'Jira-adres moet https zijn.');
  return url.origin;
}

class JiraApi {
  constructor({ site, email, token }) {
    this.site = normalizeSite(site);
    this.auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
  }

  async request(path, query = {}) {
    const url = new URL(path, this.site);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res, data;
    try {
      res = await fetch(url, { headers: { Authorization: this.auth, Accept: 'application/json' }, signal: ctrl.signal });
      const raw = await res.text();
      try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
    } catch {
      throw new JiraError('network', ctrl.signal.aborted ? 'Jira reageert niet.' : 'Geen verbinding met Jira.');
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return data;
    if (res.status === 401) throw new JiraError('auth', 'Jira accepteert het e-mailadres of de API token niet.', 401);
    if (res.status === 403) throw new JiraError('forbidden', 'Geen toegang tot dit Jira-onderdeel.', 403);
    if (res.status === 404) throw new JiraError('not_found', 'Niet gevonden in Jira.', 404);
    const msg = data?.errorMessages?.[0] || Object.values(data?.errors || {})[0];
    throw new JiraError('unknown', msg || `Jira gaf status ${res.status}.`, res.status);
  }

  issueUrl(key) {
    return `${this.site}/browse/${encodeURIComponent(key)}`;
  }

  toIssue(raw) {
    const f = raw.fields || {};
    return {
      key: raw.key,
      id: String(raw.id ?? ''),
      summary: f.summary || '',
      status: f.status?.name,
      statusCategory: f.status?.statusCategory?.key, // new | indeterminate | done
      projectKey: f.project?.key || raw.key.split('-')[0],
      projectName: f.project?.name,
      url: this.issueUrl(raw.key),
    };
  }

  async myself() {
    const me = await this.request('/rest/api/3/myself');
    return { name: me?.displayName || me?.emailAddress || 'Jira-gebruiker', accountId: me?.accountId };
  }

  async jql(jql, max = 20) {
    const data = await this.request('/rest/api/3/search/jql', {
      jql,
      maxResults: max,
      fields: 'summary,status,project',
    });
    return (data?.issues || []).map((i) => this.toIssue(i));
  }

  async issue(key) {
    return this.toIssue(await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: 'summary,status,project' }));
  }

  /** Empty query → my open tickets. "ABC-12" → that ticket first. Text → Jira's issue picker. */
  async search(query, { projectKey } = {}) {
    const q = String(query || '').trim();
    if (!q) {
      const scope = projectKey && /^[A-Z][A-Z0-9_]+$/i.test(projectKey)
        ? `(assignee = currentUser() OR project = ${projectKey})`
        : 'assignee = currentUser()';
      return this.jql(`${scope} AND statusCategory != Done ORDER BY updated DESC`, 25);
    }
    const results = [];
    if (KEY_RE.test(q)) {
      try { results.push(await this.issue(q.toUpperCase())); } catch { /* not found: fall through */ }
    }
    const picker = await this.request('/rest/api/3/issue/picker', { query: q, showSubTasks: true, showSubTaskParent: true });
    const seen = new Set(results.map((r) => r.key));
    for (const section of picker?.sections || []) {
      for (const it of section.issues || []) {
        if (seen.has(it.key)) continue;
        seen.add(it.key);
        results.push({
          key: it.key,
          id: String(it.id ?? ''),
          summary: it.summaryText || '',
          projectKey: it.key.split('-')[0],
          url: this.issueUrl(it.key),
        });
      }
    }
    return results.slice(0, 25);
  }
}

module.exports = { JiraApi, JiraError, normalizeSite, KEY_RE };
