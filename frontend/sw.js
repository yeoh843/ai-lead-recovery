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
        saveAuthToIDB(msg.token, apiUrl);
        startPolling();
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

// ── Upcoming appointment reminders ───────────────────────────────────────────

async function checkUpcomingReminders() {
    try {
        const res = await fetch(`${apiUrl}/api/appointments`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });
        if (!res.ok) return;
        const { appointments = [] } = await res.json();

        const now  = Date.now();
        const openClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const appOpen = openClients.some(c => new URL(c.url).origin === self.location.origin);

        for (const apt of appointments) {
            if (apt.status !== 'scheduled' || !apt.date || !apt.time) continue;

            // Parse as LOCAL time (same logic as parseLocalDateTime in the page)
            const [yr, mo, dy] = apt.date.split('-').map(Number);
            const [hr, mn]     = (apt.time || '0:00').split(':').map(Number);
            const aptTime      = new Date(yr, mo - 1, dy, hr, mn, 0).getTime();
            // Allow up to 2 minutes past appointment time to cover polling gaps
            if (isNaN(aptTime) || aptTime < now - 2 * 60_000) continue;

            const minsUntil = Math.round((aptTime - now) / 60_000);
            const leadName  = apt.lead
                ? (`${apt.lead.first_name || ''} ${apt.lead.last_name || ''}`.trim() || apt.lead.email)
                : 'Unknown lead';
            const timeLabel = `${apt.date} at ${apt.time}`;

            // ── Tier 1: 24-hour heads-up ──
            const key24h = `${apt.id}-24h`;
            if (minsUntil > 60 && minsUntil <= 1440 && !shownReminders.has(key24h)) {
                shownReminders.add(key24h);
                const hoursUntil = Math.round(minsUntil / 60);

                if (!appOpen) {
                    await self.registration.showNotification(`⏰ Appointment in ${hoursUntil}h`, {
                        body:  `${leadName} · ${timeLabel} • Click to view`,
                        icon:  '/favicon.ico',
                        badge: '/favicon.ico',
                        tag:   `apt-24h-${apt.id}`,
                        data:  { url: '/appointments', type: 'reminder_24h', aptId: apt.id }
                    });
                }
                await broadcastToClients({
                    type: 'SW_REMINDER', reminderType: '24h',
                    apt, hoursUntil, leadName, timeLabel
                });
            }

            // ── Tier 2: 1-hour "prepare now" reminder ──
            const key1h = `${apt.id}-1h`;
            if (minsUntil > 15 && minsUntil <= 60 && !shownReminders.has(key1h)) {
                shownReminders.add(key1h);

                if (!appOpen) {
                    await self.registration.showNotification(`🟡 Appointment in ${minsUntil} min — prepare!`, {
                        body:   `${leadName} · ${timeLabel} • Click to view`,
                        icon:   '/favicon.ico',
                        badge:  '/favicon.ico',
                        tag:    `apt-1h-${apt.id}`,
                        data:   { url: '/appointments', type: 'reminder_1h', aptId: apt.id }
                    });
                }
                await broadcastToClients({
                    type: 'SW_REMINDER', reminderType: '1h',
                    apt, minsUntil, leadName, timeLabel
                });
            }

            // ── Tier 3: 15-minute URGENT reminder ──
            const key15m = `${apt.id}-15m`;
            if (minsUntil <= 15 && minsUntil >= 0 && !shownReminders.has(key15m)) {
                shownReminders.add(key15m);
                const label = minsUntil <= 0 ? 'Starting NOW!' : `in ${minsUntil} min!`;

                if (!appOpen) {
                    await self.registration.showNotification(`🔴 Appointment ${label}`, {
                        body:             `${leadName} · ${timeLabel} • Click to view`,
                        icon:             '/favicon.ico',
                        badge:            '/favicon.ico',
                        tag:              `apt-15m-${apt.id}`,
                        requireInteraction: true,
                        vibrate:          [300, 100, 300, 100, 300],
                        data:             { url: '/appointments', type: 'reminder_15m', aptId: apt.id }
                    });
                }
                await broadcastToClients({
                    type: 'SW_REMINDER', reminderType: '15m',
                    apt, minsUntil, leadName, timeLabel
                });
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
