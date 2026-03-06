'use strict';

// ── ZeroTouch Mail AI — Service Worker ──────────────────────────────────────
// Provides appointment notifications even when the app tab is in the background
// or the user is browsing another website entirely.

const SW_VERSION = '1.1.0';
const IDB_NAME   = 'ztm-sw';
const IDB_VER    = 1;

let authToken    = null;
let apiUrl       = 'http://localhost:3000';
let pollingTimer = null;

// User-configured reminder rules (loaded from API or set via message from page)
let reminderRules = null;

const DEFAULT_REMINDER_RULES = [
    { value: 3,  unit: 'days',    minutes: 4320 },
    { value: 1,  unit: 'hours',   minutes: 60   },
    { value: 15, unit: 'minutes', minutes: 15   }
];

// Which reminder keys we've already fired this SW session
// (survives tab-switching; resets only when SW is fully terminated)
const shownReminders = new Set();

// ── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener('install', () => {
    console.log('[SW] Installing v' + SW_VERSION);
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    console.log('[SW] Activating v' + SW_VERSION);
    event.waitUntil(
        clients.claim().then(() => restoreAuthFromIDB())
    );
});

// ── Messages from the page ───────────────────────────────────────────────────

self.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.type === 'AUTH') {
        authToken = msg.token;
        if (msg.url) apiUrl = msg.url;
        if (msg.reminderRules) reminderRules = msg.reminderRules;
        saveAuthToIDB(msg.token, apiUrl);
        startPolling();
    } else if (msg.type === 'REMINDER_RULES') {
        // Page sends updated rules when user saves settings
        if (msg.rules) reminderRules = msg.rules;
    } else if (msg.type === 'LOGOUT') {
        authToken = null;
        stopPolling();
        clearAuthFromIDB();
    } else if (msg.type === 'KEEPALIVE') {
        // Page pings us every 25 s to keep the SW alive
        if (event.source) event.source.postMessage({ type: 'SW_ALIVE' });
    }
});

// ── Polling ──────────────────────────────────────────────────────────────────

function startPolling() {
    if (pollingTimer) return;           // already running
    runChecks();                        // immediate first check
    pollingTimer = setInterval(runChecks, 60_000); // then every 60 s
}

function stopPolling() {
    if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
}

async function runChecks() {
    if (!authToken) return;
    await Promise.allSettled([
        checkNewAppointments(),
        checkUpcomingReminders()
    ]);
}

// ── New AI-detected appointments ─────────────────────────────────────────────

async function checkNewAppointments() {
    try {
        const res = await fetch(`${apiUrl}/api/appointments/notifications`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });
        if (!res.ok) return;
        const { notifications = [] } = await res.json();
        if (!notifications.length) return;

        // Check whether the app is already open in any tab
        const openClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const appOpen = openClients.some(c => new URL(c.url).origin === self.location.origin);

        for (const apt of notifications) {
            const leadName = apt.lead
                ? (`${apt.lead.first_name || ''} ${apt.lead.last_name || ''}`.trim() || apt.lead.email)
                : 'A lead';
            const dateStr = apt.date ? ` on ${apt.date}` : '';
            const timeStr = apt.time ? ` at ${apt.time}` : '';
            const body    = `${leadName}${dateStr}${timeStr} (${apt.appointment_type || 'call'}) • Click to view`;

            if (!appOpen) {
                // App not visible — show a native OS notification
                await self.registration.showNotification('📅 New Appointment Detected!', {
                    body,
                    icon:             '/favicon.ico',
                    badge:            '/favicon.ico',
                    tag:              `apt-new-${apt.id}`,
                    requireInteraction: true,
                    vibrate:          [200, 100, 200],
                    data: { url: '/appointments', type: 'appointment_detected', aptId: apt.id }
                });
            }

            // Either way, tell any open page clients so they can play sound + show toast
            await broadcastToClients({ type: 'SW_APPOINTMENT_DETECTED', apt });
        }
    } catch (e) {
        console.error('[SW] checkNewAppointments:', e);
    }
}

// ── Parse date+time in a specific IANA timezone (mirrors parseInTimezone on the page) ─────────
function parseAptTime(date, time, tz) {
    const [yr, mo, dy] = date.split('-').map(Number);
    const [hr, mn]     = (time || '0:00').split(':').map(Number);
    if (!tz || tz === 'local') return new Date(yr, mo - 1, dy, hr, mn, 0).getTime();
    if (tz === 'UTC') return Date.UTC(yr, mo - 1, dy, hr, mn, 0);
    try {
        const ref  = new Date(Date.UTC(yr, mo - 1, dy, hr, mn, 0));
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(ref);
        const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
        const tzH = p.hour === '24' ? 0 : +p.hour;
        const desiredMs  = Date.UTC(yr, mo - 1, dy, hr, mn);
        const tzShowsMs  = Date.UTC(+p.year, +p.month - 1, +p.day, tzH, +p.minute);
        return ref.getTime() + (desiredMs - tzShowsMs);
    } catch (_) {
        return new Date(yr, mo - 1, dy, hr, mn, 0).getTime();
    }
}

// ── Upcoming appointment reminders ───────────────────────────────────────────

async function checkUpcomingReminders() {
    try {
        const res = await fetch(`${apiUrl}/api/appointments`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });
        if (!res.ok) return;
        const { appointments = [] } = await res.json();

        // Fetch user's reminder rules on first run (or if not yet loaded)
        if (!reminderRules) {
            try {
                const ruleRes = await fetch(`${apiUrl}/api/settings/reminders`, {
                    headers: { Authorization: `Bearer ${authToken}` }
                });
                if (ruleRes.ok) { const d = await ruleRes.json(); reminderRules = d.rules; }
            } catch (_) {}
        }
        const rules = (reminderRules && reminderRules.length > 0)
            ? reminderRules
            : DEFAULT_REMINDER_RULES;

        const now  = Date.now();
        const openClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const appOpen = openClients.some(c => new URL(c.url).origin === self.location.origin);

        for (const apt of appointments) {
            if (apt.status !== 'scheduled' || !apt.date || !apt.time) continue;

            const aptTime = parseAptTime(apt.date, apt.time, apt.timezone);
            if (isNaN(aptTime) || aptTime < now - 2 * 60_000) continue;

            const minsUntil = Math.round((aptTime - now) / 60_000);
            const leadName  = apt.lead
                ? (`${apt.lead.first_name || ''} ${apt.lead.last_name || ''}`.trim() || apt.lead.email)
                : 'Unknown lead';
            const timeLabel = `${apt.date} at ${apt.time}${apt.timezone ? ` (${apt.timezone})` : ''}`;

            for (const rule of rules) {
                const key = `${apt.id}-${rule.minutes}m`;
                if (shownReminders.has(key)) continue;

                // Fire if minsUntil is within ±5 min of the rule's offset
                const diff = minsUntil - rule.minutes;
                if (minsUntil >= 0 && diff >= -5 && diff <= 5) {
                    shownReminders.add(key);

                    const label = rule.unit === 'days'
                        ? `${rule.value} day${rule.value !== 1 ? 's' : ''}`
                        : rule.unit === 'hours'
                        ? `${rule.value} hour${rule.value !== 1 ? 's' : ''}`
                        : minsUntil <= 0
                        ? 'Starting NOW'
                        : `${rule.value} min`;

                    const isUrgent = rule.minutes <= 30;
                    const icon = minsUntil <= 0 ? '🔴' : isUrgent ? '🟡' : '⏰';

                    // ALWAYS show the OS notification — regardless of whether the app tab is open.
                    // Without this, users on Facebook/YouTube with ZTM open in a background tab
                    // never see the PC corner notification since the broadcast only reaches the
                    // hidden ZTM tab they're not looking at.
                    await self.registration.showNotification(
                        minsUntil <= 0
                            ? `🔴 Appointment starting NOW!`
                            : `${icon} Appointment in ${label}`,
                        {
                            body:               `${leadName} · ${timeLabel} • Click to view`,
                            icon:               '/favicon.ico',
                            badge:              '/favicon.ico',
                            tag:                `apt-${apt.id}-${rule.minutes}m`,
                            requireInteraction: isUrgent,
                            vibrate:            isUrgent ? [300, 100, 300, 100, 300] : [200, 100, 200],
                            silent:             false, // always play system notification sound
                            data:               { url: '/appointments', type: `reminder_${rule.minutes}m`, aptId: apt.id }
                        }
                    );

                    // Also broadcast to any open page clients (in-app toast + Web Audio ding)
                    await broadcastToClients({
                        type: 'SW_REMINDER', reminderType: `${rule.minutes}m`,
                        apt, minsUntil, leadName, timeLabel, label, isUrgent
                    });
                }
            }
        }
    } catch (e) {
        console.error('[SW] checkUpcomingReminders:', e);
    }
}

// ── Notification click → open / focus app ────────────────────────────────────

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const notifData = event.notification.data || {};
    const targetUrl = notifData.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            // Focus an existing app window if one is open
            for (const c of clientList) {
                if (new URL(c.url).origin === self.location.origin) {
                    c.postMessage({ type: 'NOTIFICATION_CLICKED', data: notifData });
                    return c.focus();
                }
            }
            // Otherwise open a new window
            return clients.openWindow(targetUrl);
        })
    );
});

// ── Broadcast to all open page clients ───────────────────────────────────────

async function broadcastToClients(msg) {
    try {
        const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        all.forEach(c => c.postMessage(msg));
    } catch (_) {}
}

// ── IndexedDB helpers (persist token across SW restarts) ─────────────────────

function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VER);
        req.onupgradeneeded = e => {
            e.target.result.createObjectStore('auth', { keyPath: 'id' });
        };
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
    });
}

async function saveAuthToIDB(token, url) {
    try {
        const db = await openIDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('auth', 'readwrite');
            tx.objectStore('auth').put({ id: 'auth', token, url });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror    = reject;
        });
    } catch (_) {}
}

async function restoreAuthFromIDB() {
    try {
        const db = await openIDB();
        const record = await new Promise((resolve, reject) => {
            const tx  = db.transaction('auth', 'readonly');
            const req = tx.objectStore('auth').get('auth');
            req.onsuccess = e => { db.close(); resolve(e.target.result); };
            req.onerror   = reject;
        });
        if (record && record.token) {
            authToken = record.token;
            if (record.url) apiUrl = record.url;
            startPolling();
            console.log('[SW] Auth restored from IDB, polling started');
        }
    } catch (_) {}
}

async function clearAuthFromIDB() {
    try {
        const db = await openIDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('auth', 'readwrite');
            tx.objectStore('auth').delete('auth');
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror    = reject;
        });
    } catch (_) {}
}
