const { SUPERADMIN_JID } = require('../../settings');
const nestClient = require('../api/nestClient');
const { jidLocal, resolveLidFromPhone, resolvePhoneFromLid, buildActorTokens } = require('./lidService');

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
        return {};
    } catch (error) {
        console.error('[ADMIN_SETTINGS_ERROR] Gagal mengambil bot settings:', error?.message);
        return {};
    }
};

const getBotAdmins = async () => {
    try {
        const response = await nestClient.get('/bot-admins');
        const payload = response?.data;
        const rows = Array.isArray(payload) ? payload : [];
        return rows.map(extractAdminCandidate).filter(Boolean);
    } catch (error) {
        console.error('[BOT_ADMINS_ERROR] Gagal mengambil daftar admin:', error?.message);
        return [];
    }
};

const listAdminJids = async () => {
    const fromApi = await getBotAdmins();
    return Array.from(new Set([SUPERADMIN_JID, ...fromApi, ...runtimeAdminOverrides].filter(Boolean)));
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

    return { removed, remaining: await listAdminJids() };
};

const isAdminJid = async (sock, jid, pushName) => {
    if (!jid) return false;

    const admins = await listAdminJids();
    const actorTokens = await buildActorTokens(jid);

    const local = jidLocal(jid);
    if (jid.endsWith('@s.whatsapp.net') && local) {
        const lid = await resolveLidFromPhone(local);
        if (lid) {
            actorTokens.add(lid);
            actorTokens.add(`${lid}@lid`);
        }
    }

    if (jid.endsWith('@lid') && local) {
        const phone = await resolvePhoneFromLid(local);
        if (phone) {
            actorTokens.add(phone);
            actorTokens.add(`${phone}@s.whatsapp.net`);
        }
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
    extractPhoneDigits,
    addAdminJid,
    listAdminJids,
    removeAdminJid,
};
