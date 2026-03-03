const adminSessions = {};

const startAdminSession = (jid) => {
    adminSessions[jid] = { step: 'SELECT_CATEGORY', data: {} };
    return adminSessions[jid];
};

const updateAdminSession = (jid, patch) => {
    if (adminSessions[jid]) {
        adminSessions[jid] = { ...adminSessions[jid], ...patch };
    }
    return adminSessions[jid];
};

const getAdminSession = (jid) => adminSessions[jid] || null;

const endAdminSession = (jid) => {
    if (adminSessions[jid]) delete adminSessions[jid];
};

module.exports = { startAdminSession, updateAdminSession, getAdminSession, endAdminSession };
