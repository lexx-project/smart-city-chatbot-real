const fs = require('fs/promises');
const path = require('path');
const { SESSION_DIR } = require('../../settings');

const jidLocal = (jid = '') => String(jid).split('@')[0] || '';

const normalizeToJid = (value = '') => {
    const digits = String(value).replace(/\D/g, '');
    if (!digits) return '';
    return `${digits}@s.whatsapp.net`;
};

const readJsonStringFile = async (filePath) => {
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return '';
    }
};

const resolvePhoneFromLid = async (lidLocalId) => {
    const reversePath = path.join(SESSION_DIR, `lid-mapping-${lidLocalId}_reverse.json`);
    const mapped = await readJsonStringFile(reversePath);
    return String(mapped || '').replace(/\D/g, '');
};

const resolveLidFromPhone = async (phoneDigits) => {
    const directPath = path.join(SESSION_DIR, `lid-mapping-${phoneDigits}.json`);
    const mapped = await readJsonStringFile(directPath);
    return String(mapped || '').replace(/\D/g, '');
};

const toSessionKey = async (jid = '') => {
    const [local = '', domain = ''] = String(jid).split('@');
    const digits = local.replace(/\D/g, '');

    if (domain === 'lid') {
        const mappedPhone = await resolvePhoneFromLid(digits);
        return mappedPhone || digits || String(jid);
    }

    return digits || String(jid);
};

const buildActorTokens = async (jid) => {
    const tokens = new Set();
    if (!jid) return tokens;

    const local = jidLocal(jid);
    if (local) tokens.add(local);
    tokens.add(jid);

    if (jid.endsWith('@lid')) {
        const phone = await resolvePhoneFromLid(local);
        if (phone) {
            tokens.add(phone);
            tokens.add(`${phone}@s.whatsapp.net`);
        }
    } else if (jid.endsWith('@s.whatsapp.net')) {
        const lid = await resolveLidFromPhone(local);
        if (lid) {
            tokens.add(lid);
            tokens.add(`${lid}@lid`);
        }
    }

    return tokens;
};

const displayAdminNumber = async (jid) => {
    const value = String(jid || '').trim();
    if (!value) return '';

    if (value.endsWith('@lid')) {
        const local = jidLocal(value);
        const mapped = await resolvePhoneFromLid(local);
        return mapped || local;
    }

    return jidLocal(value).replace(/\D/g, '');
};

module.exports = {
    jidLocal,
    normalizeToJid,
    resolvePhoneFromLid,
    resolveLidFromPhone,
    toSessionKey,
    buildActorTokens,
    displayAdminNumber,
};
