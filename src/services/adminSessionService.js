const fs = require('fs');
const path = require('path');
const { nestClient } = require('../api/nestClient');

const SESSION_FILE = path.join(__dirname, '../../wa_staff_sessions.json');

const loadSessions = () => {
    if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return {};
};

const saveSession = (sessions) => fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));

const loginStaffWa = async (jid, email, password) => {
    try {
        const res = await nestClient.post('auth/staff/login', { email, password });
        const data = res.data?.data || res.data;
        if (data?.accessToken) {
            const sessions = loadSessions();
            sessions[jid] = {
                id: data.id,
                name: data.fullName || data.name,
                role: (data.role?.name || data.role || 'ADMIN').toUpperCase(),
                token: data.accessToken
            };
            saveSession(sessions);
            return { success: true, name: sessions[jid].name, role: sessions[jid].role };
        }
        return { success: false, message: 'Token tidak ditemukan.' };
    } catch (error) {
        return { success: false, message: error.response?.data?.message || 'Login Gagal.' };
    }
};

const getAuthenticatedStaff = (jid) => loadSessions()[jid] || null;

// Preserve existing wizard session functions
// Preserve existing wizard session functions
const { getAdminTimeout } = require('./adminSettingsService');
const adminSessions = {};

const clearAdminSessionTimer = (jid) => {
    if (adminSessions[jid] && adminSessions[jid].timeoutId) {
        clearTimeout(adminSessions[jid].timeoutId);
        adminSessions[jid].timeoutId = null;
    }
};

const refreshAdminSessionTimeout = (jid) => {
    clearAdminSessionTimer(jid);
    if (adminSessions[jid]) {
        const timeoutSeconds = getAdminTimeout();
        adminSessions[jid].timeoutId = setTimeout(() => {
            endAdminSession(jid);
            console.log(`[ADMIN_SESSION_TIMEOUT] Sesi admin untuk ${jid} telah dihapus otomatis.`);
        }, timeoutSeconds * 1000);
    }
};

const startAdminSession = (jid) => {
    clearAdminSessionTimer(jid);
    adminSessions[jid] = { step: 'SELECT_CATEGORY', data: {} };
    refreshAdminSessionTimeout(jid);
    return adminSessions[jid];
};

const updateAdminSession = (jid, patch) => {
    if (adminSessions[jid]) {
        adminSessions[jid] = { ...adminSessions[jid], ...patch };
        refreshAdminSessionTimeout(jid);
    }
    return adminSessions[jid];
};

const getAdminSession = (jid) => adminSessions[jid] || null;

const endAdminSession = (jid) => {
    clearAdminSessionTimer(jid);
    if (adminSessions[jid]) delete adminSessions[jid];
};

module.exports = { loginStaffWa, getAuthenticatedStaff, startAdminSession, updateAdminSession, getAdminSession, endAdminSession };
