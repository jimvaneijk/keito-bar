// Meeting detection (main process).
//
// Signal: which apps are recording from a microphone (native/mic-monitor, macOS 14+).
// Context: Teams / Zoom / Slack / FaceTime / Webex use the mic → that's the meeting app.
//          A browser uses the mic → ask that browser (Apple Events) for a Google Meet,
//          Teams-web or Zoom-web tab and take the meeting name from the tab title.
//
// Events:
//   'start'       { id, source, title, appName, startedAt }   after `startDelayMs` in a call
//   'end'         { id, source, title, startedAt, endedAt }   after `endDelayMs` without mic
//   'unsupported'                                               macOS < 14 or no helper

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const readline = require('readline');

// Bundle-id prefixes (lower case). Helper processes like "com.google.Chrome.helper" match too.
const CALL_APPS = [
    { prefix: 'com.microsoft.teams', source: 'Microsoft Teams' },
    { prefix: 'us.zoom.', source: 'Zoom' },
    { prefix: 'com.tinyspeck.slackmacgap', source: 'Slack-huddle' },
    { prefix: 'com.apple.facetime', source: 'FaceTime' },
    { prefix: 'com.cisco.webex', source: 'Webex' },
    { prefix: 'cisco-systems.spark', source: 'Webex' },
    { prefix: 'com.hnc.discord', source: 'Discord' },
];

// Browsers whose tabs we can read with JavaScript for Automation.
const BROWSERS = [
    { prefix: 'com.google.chrome', appId: 'com.google.Chrome', name: 'Google Chrome', kind: 'chromium' },
    { prefix: 'company.thebrowser.browser', appId: 'company.thebrowser.Browser', name: 'Arc', kind: 'chromium' },
    { prefix: 'com.microsoft.edgemac', appId: 'com.microsoft.edgemac', name: 'Microsoft Edge', kind: 'chromium' },
    { prefix: 'com.brave.browser', appId: 'com.brave.Browser', name: 'Brave', kind: 'chromium' },
    { prefix: 'com.vivaldi.vivaldi', appId: 'com.vivaldi.Vivaldi', name: 'Vivaldi', kind: 'chromium' },
    { prefix: 'com.apple.webkit.gpu', appId: 'com.apple.Safari', name: 'Safari', kind: 'safari' },
    { prefix: 'com.apple.safari', appId: 'com.apple.Safari', name: 'Safari', kind: 'safari' },
    { prefix: 'org.mozilla.firefox', appId: null, name: 'Firefox', kind: 'unreadable' },
];

const MEETING_TABS = [
    {
        source: 'Google Meet',
        url: /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/,
        title: (title) => title.replace(/^Meet\s*[–—-]\s*/, '').replace(/\s*[–—-]\s*Google Meet$/, ''),
    },
    {
        source: 'Microsoft Teams',
        url: /^https:\/\/teams\.(microsoft|live)\.com\//,
        title: (title) => title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*Microsoft Teams.*$/, ''),
    },
    {
        source: 'Zoom',
        url: /^https:\/\/([a-z0-9-]+\.)?zoom\.us\/(wc|j)\//,
        title: (title) => title.replace(/\s*[-|]\s*Zoom.*$/i, ''),
    },
];

// Titles that are not a meeting name.
const GENERIC_TITLE =
    /^(meet|google meet|microsoft teams|teams|chat|calendar|agenda|activity|zoom|meeting|[a-z]{3}-[a-z]{4}-[a-z]{3})$/i;

function classifyProcess(bundleId) {
    const lower = String(bundleId || '').toLowerCase();
    if (!lower) return null;
    const callApp = CALL_APPS.find((app) => lower.startsWith(app.prefix));
    if (callApp) return { type: 'app', source: callApp.source };
    const browser = BROWSERS.find((candidate) => lower.startsWith(candidate.prefix));
    if (browser) return { type: 'browser', browser };
    return null; // dictation, Siri, voice memos, music apps… are not meetings
}

function cleanTitle(rawTitle, matcher) {
    const title = matcher.title(String(rawTitle || '').trim()).trim();
    return title && !GENERIC_TITLE.test(title) ? title.slice(0, 120) : null;
}

/** Picks the best meeting tab: a recognised URL, preferring tabs that have a real meeting name. */
function findMeetingTab(tabs) {
    const found = [];
    for (const [url, title] of tabs) {
        const matcher = MEETING_TABS.find((candidate) => candidate.url.test(String(url || '')));
        if (matcher) found.push({ source: matcher.source, title: cleanTitle(title, matcher) });
    }
    return found.find((tab) => tab.title) || found[0] || null;
}

function browserTabsScript(browser) {
    const appId = JSON.stringify(browser.appId);
    const titleGetter = browser.kind === 'safari' ? 'name' : 'title';
    return `
        const app = Application(${appId});
        if (!app.running()) { JSON.stringify([]); } else {
            JSON.stringify(app.windows().flatMap((w) => w.tabs().map((t) => [t.url(), t.${titleGetter}()])));
        }`;
}

function readBrowserTabs(browser) {
    return new Promise((resolve) => {
        if (!browser.appId) return resolve({ tabs: [], error: 'unreadable' });
        execFile(
            'osascript',
            ['-l', 'JavaScript', '-e', browserTabsScript(browser)],
            { timeout: 8000 },
            (error, stdout, stderr) => {
                if (error) {
                    const denied = /-1743|not allowed|niet toegestaan/i.test(String(stderr || error.message));
                    return resolve({ tabs: [], error: denied ? 'permission' : 'failed' });
                }
                try {
                    resolve({ tabs: JSON.parse(stdout.trim() || '[]') });
                } catch {
                    resolve({ tabs: [], error: 'failed' });
                }
            },
        );
    });
}

class MeetingDetector extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.helperPath       path to the mic-monitor binary
     * @param {() => number} options.startDelayMs  how long the mic must be in use before we ask
     * @param {number} [options.endDelayMs]     how long without mic before the meeting counts as ended
     * @param {Function} [options.readTabs]     injectable for tests
     * @param {Function} [options.now]          injectable for tests
     */
    constructor({ helperPath, startDelayMs, endDelayMs = 45_000, readTabs = readBrowserTabs, now = Date.now }) {
        super();
        this.helperPath = helperPath;
        this.startDelayMs = startDelayMs;
        this.endDelayMs = endDelayMs;
        this.readTabs = readTabs;
        this.now = now;
        this.child = null;
        this.supported = null; // null = unknown yet
        this.callSince = null; // timestamp the current call started (mic in use by a call app/browser)
        this.callProcesses = [];
        this.meeting = null; // announced meeting
        this.startTimer = null;
        this.endTimer = null;
        this.sequence = 0;
    }

    /** True while a call app or browser is using the microphone. */
    get inCall() {
        return this.callSince !== null;
    }

    start() {
        if (this.child || process.platform !== 'darwin') return;
        if (!this.helperPath || !fs.existsSync(this.helperPath)) {
            this.supported = false;
            this.emit('unsupported', 'helper-missing');
            return;
        }
        this.child = spawn(this.helperPath, [], { stdio: ['ignore', 'pipe', 'ignore'] });
        readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line));
        this.child.on('exit', () => {
            this.child = null;
        });
        this.child.on('error', () => {
            this.child = null;
            this.supported = false;
            this.emit('unsupported', 'helper-failed');
        });
    }

    stop() {
        if (this.child) this.child.kill();
        this.child = null;
        clearTimeout(this.startTimer);
        clearTimeout(this.endTimer);
    }

    handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        if (message.unsupported) {
            this.supported = false;
            this.emit('unsupported', 'macos');
            return;
        }
        this.supported = true;
        if (Array.isArray(message.input)) this.updateInputProcesses(message.input);
    }

    /** Called with the processes that currently record from a microphone. */
    updateInputProcesses(processes) {
        const callProcesses = processes
            .map((inputProcess) => ({ ...inputProcess, classification: classifyProcess(inputProcess.bundleId) }))
            .filter((inputProcess) => inputProcess.classification);

        if (callProcesses.length) {
            this.callProcesses = callProcesses;
            clearTimeout(this.endTimer);
            this.endTimer = null;
            if (this.callSince === null) {
                this.callSince = this.now();
                clearTimeout(this.startTimer);
                this.startTimer = setTimeout(() => this.confirmMeeting(), Math.max(0, this.startDelayMs()));
            }
            return;
        }

        // No call app uses the mic any more.
        if (this.meeting) {
            if (!this.endTimer) this.endTimer = setTimeout(() => this.finishMeeting(), this.endDelayMs);
        } else {
            clearTimeout(this.startTimer);
            this.callSince = null;
            this.callProcesses = [];
        }
    }

    async confirmMeeting() {
        if (this.callSince === null || this.meeting) return;
        const startedAt = this.callSince;
        const identified = await this.identify(this.callProcesses);
        if (this.callSince !== startedAt || this.meeting) return; // call ended while we were looking
        if (!identified) return; // a browser using the mic without a meeting tab: probably not a meeting
        this.meeting = { id: `meeting-${startedAt}-${++this.sequence}`, ...identified, startedAt };
        this.emit('start', { ...this.meeting });
    }

    finishMeeting() {
        const meeting = this.meeting;
        this.meeting = null;
        this.endTimer = null;
        this.callSince = null;
        this.callProcesses = [];
        if (meeting) this.emit('end', { ...meeting, endedAt: this.now() - this.endDelayMs });
    }

    /** Works out which meeting this is: a dedicated call app wins, otherwise a browser tab. */
    async identify(processes) {
        const app = processes.find((inputProcess) => inputProcess.classification.type === 'app');
        if (app) return { source: app.classification.source, title: null, appName: app.classification.source };

        const seen = new Set();
        for (const inputProcess of processes) {
            const browser = inputProcess.classification.browser;
            if (seen.has(browser.name)) continue;
            seen.add(browser.name);
            const { tabs, error } = await this.readTabs(browser);
            const tab = findMeetingTab(tabs);
            if (tab) return { source: tab.source, title: tab.title, appName: browser.name };
            if (error) {
                // No permission (or Firefox): we know the browser is in a call, not which one.
                return {
                    source: `Gesprek in ${browser.name}`,
                    title: null,
                    appName: browser.name,
                    tabsUnavailable: error,
                };
            }
        }
        return null;
    }

    /** For the "Probeer" button in settings. */
    simulate() {
        const startedAt = this.now() - this.startDelayMs();
        return {
            id: `meeting-test-${startedAt}`,
            source: 'Google Meet',
            title: 'Weekly sync',
            appName: 'Google Chrome',
            startedAt,
            test: true,
        };
    }
}

module.exports = { MeetingDetector, classifyProcess, findMeetingTab, readBrowserTabs, browserTabsScript };
