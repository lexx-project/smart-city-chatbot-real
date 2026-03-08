const fs = require('fs');
const path = require('path');
const { SESSION_DIR } = require('../../settings');
const { jidLocal, resolveLidFromPhone, resolvePhoneFromLid, buildActorTokens } = require('./lidService');
const { nestClient } = require('../api/nestClient');
const { getAdminToken } = require('./adminAuthService');


const runtimeAdminOverrides = new Set();

const extractDigits = (value = '') => String(value || '').replace(/\D/g, '');
const extractPhoneDigits = (jid = '') => extractDigits(String(jid || '').split('@')[0] || '');

const toWhatsappJid = (value = '') => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.includes('@')) return raw;

    const digits = extractDigits(raw);
    if (!digits) return '';
    return `${digits}@s.whatsapp.net`;
};

const extractAdminCandidate = (item) => {
    if (!item) return '';

    if (typeof item === 'string') {
        return toWhatsappJid(item);
    }

    if (typeof item === 'object') {
        const directJid = toWhatsappJid(item.jid || item.adminJid || item.whatsappJid || item.whatsapp || item.id);
        if (directJid) return directJid;

        const digitCandidate =
            extractDigits(item.phoneNumber) ||
            extractDigits(item.phone) ||
            extractDigits(item.msisdn) ||
            extractDigits(item.number) ||
            extractDigits(item.mobile);

        if (digitCandidate) return `${digitCandidate}@s.whatsapp.net`;
    }

    return '';
};

const getAdminSettings = async () => {
    try {
        const response = await nestClient.get('/bot-settings');
        if (response?.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
            return response.data;
        }
        return { GREETING_MSG: 'Halo! 👋', SESSION_END_TEXT: 'Terima kasih.' };
    } catch (error) {
        console.error('[ADMIN_SETTINGS_ERROR] Gagal mengambil bot settings:', error?.message);
        return { GREETING_MSG: 'Halo! 👋', SESSION_END_TEXT: 'Terima kasih.' };
    }
};

// ══════════════════════════════════════════════════════════
//  DYNAMIC ADMIN CACHE
// ══════════════════════════════════════════════════════════

let cachedAdmins = null;         // array of JID strings once populated
let lastAdminFetchTime = 0;
const ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch authorized bot-admin JIDs from the backend.
 * Converts phone formats (e.g. '08xxx' or '628xxx') to WhatsApp JIDs.
 * Falls back to SUPERADMIN_JID on API failure.
 */
const fetchBotAdmins = async () => {
    try {
        const token = await getAdminToken();
        const res = await nestClient.get('/staff', {
            headers: { Authorization: `Bearer ${token}` },
            params: { limit: 100 }
        });

        const staffList = res.data?.data || [];

        // Ambil nomor WA staff yang role-nya ADMIN / Super Admin
        const adminPhones = staffList
            .filter(staff => staff.role?.name?.toUpperCase().includes('ADMIN') || staff.role === 'ADMIN')
            .map(staff => staff.phoneNumber || staff.phone)
            .filter(Boolean); // Buang yang kosong

        if (adminPhones.length === 0) {
            cachedAdmins = ['62882009391607'];
        } else {
            const jids = adminPhones
                .map(item => extractAdminCandidate(item))
                .filter(Boolean);
            cachedAdmins = jids;
        }

        lastAdminFetchTime = Date.now();
        console.log(`[ADMIN_CACHE] Refreshed — ${cachedAdmins.length} admin(s) loaded from /staff.`);
    } catch (err) {
        console.error('[ADMIN_CACHE] fetchBotAdmins failed:', err?.message);
        if (!cachedAdmins || cachedAdmins.length === 0) {
            cachedAdmins = ['62882009391607'];
        }
    }
    return cachedAdmins;
};

/**
 * Async admin check — resolves LIDs and compares against cached admin list.
 */
const checkIsAdmin = async (jid) => {
    if (!jid) return false;

    // Refresh cache if stale or missing
    if (!cachedAdmins || Date.now() - lastAdminFetchTime > ADMIN_CACHE_TTL) {
        await fetchBotAdmins();
    }

    // Build actor tokens (same logic as isAdminJid but async-capable)
    const actorTokens = new Set();
    const local = jidLocal(jid);
    if (local) actorTokens.add(local);
    actorTokens.add(jid);

    if (jid.endsWith('@lid') && local) {
        const phone = await resolvePhoneFromLid(local);
        if (phone) {
            actorTokens.add(phone);
            actorTokens.add(`${phone}@s.whatsapp.net`);
        }
    } else if (jid.endsWith('@s.whatsapp.net') && local) {
        const lid = await resolveLidFromPhone(local);
        if (lid) {
            actorTokens.add(lid);
            actorTokens.add(`${lid}@lid`);
        }
    }

    for (const candidate of cachedAdmins) {
        const candidateJid = toWhatsappJid(candidate);
        if (!candidateJid) continue;
        const candidateLocal = jidLocal(candidateJid);
        if (actorTokens.has(candidateJid) || actorTokens.has(candidateLocal)) return true;
    }

    return false;
};

const listAdminJids = () => {
    const fromCache = cachedAdmins || [];
    return Array.from(new Set([...fromCache, ...runtimeAdminOverrides].filter(Boolean)));
};

const addAdminJid = async (targetJid) => {
    const normalized = toWhatsappJid(targetJid);
    if (normalized) runtimeAdminOverrides.add(normalized);
    return listAdminJids();
};

const removeAdminJid = async (candidate) => {
    const raw = String(candidate || '').trim();
    const digits = extractDigits(raw);
    const targets = new Set();

    if (raw.includes('@')) targets.add(raw);
    if (digits) {
        targets.add(`${digits}@s.whatsapp.net`);
        const lid = await resolveLidFromPhone(digits);
        if (lid) targets.add(`${lid}@lid`);
    }

    let removed = false;
    for (const value of Array.from(runtimeAdminOverrides)) {
        if (targets.has(value)) {
            runtimeAdminOverrides.delete(value);
            removed = true;
        }
    }

    return { removed, remaining: listAdminJids() };
};

const isAdminJid = (sock, jid, pushName) => {
    if (!jid) return false;

    const admins = listAdminJids();
    const actorTokens = new Set();

    const local = jidLocal(jid);
    if (local) actorTokens.add(local);
    actorTokens.add(jid);

    try {
        if (jid.endsWith('@s.whatsapp.net') && local) {
            const directPath = path.join(SESSION_DIR, `lid-mapping-${local}.json`);
            if (fs.existsSync(directPath)) {
                const mapped = JSON.parse(fs.readFileSync(directPath, 'utf8'));
                const lid = String(mapped || '').replace(/\D/g, '');
                if (lid) {
                    actorTokens.add(lid);
                    actorTokens.add(`${lid}@lid`);
                }
            }
        }

        if (jid.endsWith('@lid') && local) {
            const reversePath = path.join(SESSION_DIR, `lid-mapping-${local}_reverse.json`);
            if (fs.existsSync(reversePath)) {
                const mapped = JSON.parse(fs.readFileSync(reversePath, 'utf8'));
                const phone = String(mapped || '').replace(/\D/g, '');
                if (phone) {
                    actorTokens.add(phone);
                    actorTokens.add(`${phone}@s.whatsapp.net`);
                }
            }
        }
    } catch (e) {
        // Abaikan error baca file
    }

    // Placeholder untuk kemungkinan auto-sync berbasis sock/pushName di masa depan.
    if (sock && pushName) {
        // No-op: signature dipertahankan untuk kompatibilitas auto-sync LID.
    }

    for (const candidate of admins) {
        const candidateJid = toWhatsappJid(candidate);
        if (!candidateJid) continue;

        const candidateLocal = jidLocal(candidateJid);
        if (actorTokens.has(candidateJid) || actorTokens.has(candidateLocal)) return true;
    }

    return false;
};

module.exports = {
    getAdminSettings,
    isAdminJid,
    checkIsAdmin,
    fetchBotAdmins,
    extractPhoneDigits,
    addAdminJid,
    listAdminJids,
    removeAdminJid,
};
