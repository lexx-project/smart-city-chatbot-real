const { SUPERADMIN_JID } = require('../../settings');
const { loadCmsData, saveCmsData } = require('./cmsService');
const { jidLocal, resolveLidFromPhone, buildActorTokens } = require('./lidService');

const isAdminJid = async (jid, cmsData) => {
    if (!jid) return false;
    const configuredAdmins = Array.isArray(cmsData?.adminJids) ? cmsData.adminJids : [];
    const allowed = [SUPERADMIN_JID, ...configuredAdmins].filter(Boolean);
    const actorTokens = await buildActorTokens(jid);

    for (const candidate of allowed) {
        const candidateJid = String(candidate).trim();
        if (!candidateJid) continue;
        const candidateLocal = jidLocal(candidateJid);
        if (actorTokens.has(candidateJid) || actorTokens.has(candidateLocal)) return true;
    }

    return false;
};

const addAdminJid = async (targetJid) => {
    const cmsData = await loadCmsData();
    const current = Array.isArray(cmsData.adminJids) ? cmsData.adminJids : [];
    if (!current.includes(targetJid)) current.push(targetJid);

    const phoneDigits = jidLocal(targetJid);
    const lid = await resolveLidFromPhone(phoneDigits);
    if (lid) {
        const lidJid = `${lid}@lid`;
        if (!current.includes(lidJid)) current.push(lidJid);
    }

    cmsData.adminJids = current;
    await saveCmsData(cmsData);
    return cmsData.adminJids;
};

const listAdminJids = async () => {
    const cmsData = await loadCmsData();
    const dynamicAdmins = Array.isArray(cmsData.adminJids) ? cmsData.adminJids : [];
    return Array.from(new Set([SUPERADMIN_JID, ...dynamicAdmins]));
};

const removeAdminJid = async (candidate) => {
    const cmsData = await loadCmsData();
    const current = Array.isArray(cmsData.adminJids) ? cmsData.adminJids : [];
    if (!current.length) return { removed: false, remaining: current };

    const raw = String(candidate || '').trim();
    const digits = raw.replace(/\D/g, '');
    const targets = new Set();

    if (raw.includes('@')) targets.add(raw);
    if (digits) {
        targets.add(`${digits}@s.whatsapp.net`);
        const lid = await resolveLidFromPhone(digits);
        if (lid) targets.add(`${lid}@lid`);
    }

    const next = current.filter((jid) => !targets.has(jid));
    const removed = next.length !== current.length;
    cmsData.adminJids = next;
    await saveCmsData(cmsData);
    return { removed, remaining: next };
};

module.exports = {
    isAdminJid,
    addAdminJid,
    listAdminJids,
    removeAdminJid,
};
