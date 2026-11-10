// Minimal Keito API v2 client. Runs in the Electron main process only, so the API key
// never reaches the renderer.
//
// Auth: "Authorization: Bearer kto_…" + "Keito-Account-Id: <Company ID>"
// (Keito → Settings → API & Developers). Needs a full-access integration key;
// a personal read-only sync key cannot track time.

const BASE_URL = 'https://app.keito.ai/api/v2';
const WEB_URL = 'https://app.keito.ai';
const USER_AGENT = 'Keito Menubar (Electron)';

class KeitoError extends Error {
    constructor(kind, message, status) {
        super(message);
        this.name = 'KeitoError';
        this.kind = kind;
        this.status = status;
    }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const toId = (value) =>
    typeof value === 'number' ? String(value) : typeof value === 'string' && value.trim() ? value : undefined;
const toNumber = (value) => {
    const number = typeof value === 'string' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
};
const text = (value) => (typeof value === 'string' && value.trim() ? value : undefined);
const clock = (value) => {
    const match = typeof value === 'string' ? value.match(/^(\d{1,2}):(\d{2})/) : null;
    return match ? `${match[1].padStart(2, '0')}:${match[2]}` : undefined;
};

function serverMessage(data) {
    if (!data || typeof data !== 'object') return undefined;
    const parts = [
        data.message,
        data.error_description,
        typeof data.error === 'string' ? data.error : data.error?.message,
    ];
    const message = parts.map(text).find(Boolean);
    if (message) return message;
    if (data.errors && typeof data.errors === 'object') {
        const first = Object.entries(data.errors)[0];
        if (first) return `${first[0]}: ${[].concat(first[1]).join(', ')}`;
    }
    return undefined;
}

function errorFor(status, data) {
    const message = serverMessage(data);
    switch (true) {
        case status === 401:
            return new KeitoError(
                'auth',
                'Keito accepteert de API key of Company ID niet. Controleer ze in de instellingen.',
                status,
            );
        case status === 403:
            return new KeitoError('forbidden', message || 'Je hebt geen rechten voor deze actie in Keito.', status);
        case status === 404:
            return new KeitoError('not_found', message || 'Niet gevonden in Keito (misschien al verwijderd).', status);
        case status === 409:
            return new KeitoError('conflict', message || 'Conflict in Keito (loopt er al een timer?).', status);
        case status === 422 || status === 400:
            return new KeitoError('validation', message || 'Keito wees de invoer af.', status);
        case status === 423:
            return new KeitoError('locked', message || 'Deze registratie is vergrendeld.', status);
        case status === 429:
            return new KeitoError('rate_limited', 'Even te veel verzoeken naar Keito. Probeer het zo opnieuw.', status);
        case status >= 500:
            return new KeitoError('server', 'Keito heeft een storing. Probeer het later opnieuw.', status);
        default:
            return new KeitoError('unknown', message || `Keito gaf status ${status}.`, status);
    }
}

class KeitoApi {
    constructor({ token, accountId, baseUrl = BASE_URL }) {
        this.token = token;
        this.accountId = accountId;
        this.base = new URL(baseUrl.replace(/\/+$/, ''));
    }

    url(pathOrLink, query = {}) {
        const basePath = this.base.pathname.replace(/\/+$/, '');
        const url = /^https?:/i.test(pathOrLink)
            ? new URL(pathOrLink)
            : pathOrLink.startsWith(basePath + '/')
              ? new URL(pathOrLink, this.base.origin)
              : new URL(`${basePath}/${pathOrLink.replace(/^\/+/, '')}`, this.base.origin);
        // Never send credentials to another host.
        if (url.origin !== this.base.origin)
            throw new KeitoError('unexpected', 'Keito gaf een link naar een ander domein.');
        for (const [key, value] of Object.entries(query))
            if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
        return url.toString();
    }

    async request(method, path, { query, body } = {}) {
        const url = this.url(path, query);
        const headers = {
            Authorization: `Bearer ${this.token}`,
            'Keito-Account-Id': this.accountId,
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
        };
        const payload = body === undefined ? undefined : JSON.stringify(body);
        if (payload !== undefined) headers['Content-Type'] = 'application/json';
        const idempotent = method === 'GET';

        for (let attempt = 0; ; attempt++) {
            const canRetry = attempt < 2;
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20000);
            let response, raw;
            try {
                response = await fetch(url, { method, headers, body: payload, signal: ctrl.signal });
                raw = await response.text();
            } catch {
                if (idempotent && canRetry) {
                    await sleep(800 * 2 ** attempt);
                    continue;
                }
                throw new KeitoError(
                    ctrl.signal.aborted ? 'timeout' : 'network',
                    ctrl.signal.aborted
                        ? 'Keito reageert niet. Probeer het opnieuw.'
                        : 'Geen verbinding met Keito. Check je internet.',
                );
            } finally {
                clearTimeout(timer);
            }
            let data;
            try {
                data = raw ? JSON.parse(raw) : undefined;
            } catch {
                data = undefined;
            }
            if (response.ok) return data;
            // 429 is rejected before processing, so retrying writes is safe; 5xx only for reads.
            if (response.status === 429 && canRetry) {
                const wait = Number(response.headers.get('retry-after')) || 2 ** attempt;
                if (wait <= 20) {
                    await sleep(wait * 1000);
                    continue;
                }
            }
            if (response.status >= 500 && idempotent && canRetry) {
                await sleep(800 * 2 ** attempt);
                continue;
            }
            throw errorFor(response.status, data);
        }
    }

    async paginate(path, key, query = {}) {
        const items = [];
        let next = this.url(path, { per_page: 100, ...query });
        for (let page = 0; next && page < 50; page++) {
            const data = await this.request('GET', next);
            const list = data?.[key];
            if (!Array.isArray(list)) throw new KeitoError('unexpected', `Keito gaf geen ${key}-lijst terug.`);
            items.push(...list);
            if (data.links?.next) next = this.url(data.links.next);
            else if (!data.links && data.page && data.total_pages && data.page < data.total_pages) {
                const nextUrl = new URL(next);
                nextUrl.searchParams.set('page', String(data.page + 1));
                next = nextUrl.toString();
            } else next = null;
        }
        return items;
    }

    // ---- Endpoints -------------------------------------------------------

    async me() {
        const raw = await this.request('GET', '/users/me');
        const userId = toId(raw?.id);
        const companyId = toId(raw?.company?.id);
        if (!userId) throw new KeitoError('unexpected', 'Keito gaf geen gebruiker terug.');
        if (!companyId && raw?.capabilities) {
            throw new KeitoError(
                'read_only_key',
                'Dit is een read-only sync key. Je hebt een full-access integration key nodig (Settings → API & Developers → Integration keys).',
            );
        }
        if (companyId && companyId !== this.accountId) {
            throw new KeitoError('company_mismatch', 'De key hoort bij een ander bedrijf dan de ingevulde Company ID.');
        }
        if (raw?.capabilities?.can_track_time === false) {
            throw new KeitoError('forbidden', 'Deze Keito-gebruiker mag geen tijd schrijven.');
        }
        return {
            userId,
            name: [raw.first_name, raw.last_name].filter(text).join(' ') || raw.email || 'Keito-gebruiker',
            email: text(raw.email),
            companyName: text(raw.company?.name),
            timezone: text(raw.company?.timezone),
            requireNotes: raw.company?.require_notes === true,
        };
    }

    async projects() {
        const raw = await this.paginate('/projects', 'projects', { is_active: true });
        return raw
            .filter((project) => toId(project?.id) && project.can_track_time !== false)
            .map((project) => ({
                id: toId(project.id),
                name: text(project.name) || 'Naamloos project',
                code: text(project.code),
                clientId: toId(project.client?.id) ?? toId(project.client_id),
                clientName: text(project.client?.name),
            }));
    }

    async tasks(projectId) {
        const raw = await this.paginate('/tasks', 'tasks', { project_id: projectId, is_active: true });
        return raw
            .filter((task) => toId(task?.id))
            .map((task) => ({ id: toId(task.id), name: text(task.name) || 'Naamloze taak' }));
    }

    async entries({ userId, from, to }) {
        const raw = await this.paginate('/time_entries', 'time_entries', { user_id: userId, from, to });
        return raw.map(normalizeEntry).filter(Boolean);
    }

    async running(userId) {
        const raw = await this.paginate('/time_entries', 'time_entries', { user_id: userId, is_running: true });
        return raw.map(normalizeEntry).filter((entry) => entry && entry.isRunning);
    }

    async create(body) {
        return normalizeEntry(await this.request('POST', '/time_entries', { body: { source: 'api', ...body } }));
    }

    async update(id, body) {
        return normalizeEntry(await this.request('PATCH', `/time_entries/${encodeURIComponent(id)}`, { body }));
    }

    async stop(id) {
        return normalizeEntry(await this.request('PATCH', `/time_entries/${encodeURIComponent(id)}/stop`));
    }

    async restart(id) {
        return normalizeEntry(
            await this.request('PATCH', `/time_entries/${encodeURIComponent(id)}/restart`, {
                body: { replace_running: true },
            }),
        );
    }

    async remove(id) {
        await this.request('DELETE', `/time_entries/${encodeURIComponent(id)}`);
    }
}

function normalizeEntry(raw) {
    const id = toId(raw?.id);
    if (!id) return null;
    const durationSeconds = toNumber(raw.duration_seconds);
    const locked = raw.approval_status === 'approved' || raw.is_locked === true || raw.is_closed === true;
    return {
        id,
        projectId: toId(raw.project?.id) ?? toId(raw.project_id),
        projectName: text(raw.project?.name),
        projectCode: text(raw.project?.code),
        taskId: toId(raw.task?.id) ?? toId(raw.task_id),
        taskName: text(raw.task?.name),
        clientName: text(raw.client?.name),
        spentDate: text(raw.spent_date) || '',
        hours: toNumber(raw.hours) ?? (durationSeconds !== undefined ? durationSeconds / 3600 : 0),
        notes: typeof raw.notes === 'string' ? raw.notes : '',
        isRunning: raw.is_running === true,
        timerStartedAt: text(raw.timer_started_at),
        startedTime: clock(raw.started_time),
        endedTime: clock(raw.ended_time),
        locked,
        lockedReason:
            raw.approval_status === 'approved'
                ? 'Goedgekeurd'
                : text(raw.locked_reason) || (locked ? 'Vergrendeld' : undefined),
        approvalStatus: text(raw.approval_status),
        createdAt: text(raw.created_at),
    };
}

module.exports = { KeitoApi, KeitoError, WEB_URL };
