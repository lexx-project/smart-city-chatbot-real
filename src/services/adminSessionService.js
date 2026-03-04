const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { NEST_API_BASE_URL } = require('../../settings');

const SESSION_FILE = path.join(__dirname, '../../wa_staff_sessions.json');
const adminSessions = {};

// Load sessions on startup
let authenticatedStaff = {};
if (fs.existsSync(SESSION_FILE)) {
    try {
        authenticatedStaff = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    } catch (err) {
        console.error('[ADMIN_SESSION] Error reading staff sessions file:', err.message);
    }
}

const saveStaffSessions = () => {
    try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify(authenticatedStaff, null, 2));
    } catch (err) {
        console.error('[ADMIN_SESSION] Error writing staff sessions file:', err.message);
    }
};

const loginStaff = async (jid, email, password) => {
    try {
        const res = await axios.post(`${NEST_API_BASE_URL}/auth/staff/login`, {
            email,
            password
        });

        const data = res.data?.data || res.data;
        const staffRaw = data.staff || {};

        const loginData = {
            id: staffRaw.id,
            email: staffRaw.email,
            name: staffRaw.fullName || staffRaw.name,
            role: staffRaw.role?.name || staffRaw.role,
            accessToken: data.accessToken || data.access_token || data.token,
            updatedAt: new Date().toISOString()
        };

        authenticatedStaff[jid] = loginData;
        saveStaffSessions();

        return { success: true, data: loginData };
    } catch (error) {
        return {
            success: false,
            message: error.response?.data?.message || error.message
        };
    }
};

const getAuthenticatedStaff = (jid) => {
    return authenticatedStaff[jid] || null;
};


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

module.exports = { startAdminSession, updateAdminSession, getAdminSession, endAdminSession, loginStaff, getAuthenticatedStaff };
