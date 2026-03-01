const { SUPERADMIN_JID } = require('../../../settings');
const { normalizeToJid, displayAdminNumber } = require('../../services/lidService');
const { addAdminJid, listAdminJids, removeAdminJid, getAdminSettings } = require('../../services/adminService');
const { sessions, endSession } = require('../../services/wargaSessionService');

const getAdminCommands = async (req, res) => {
    return res.status(200).json({
        success: true,
        data: ['/menuadmin', '/setting', '/addadmin', '/listadmin', '/deladmin', '/totalchat', '/totalsesi', '/batal'],
    });
};

const listAdmins = async (req, res) => {
    try {
        const admins = await listAdminJids();
        const numbers = [];
        for (const jid of admins) numbers.push(await displayAdminNumber(jid));
        return res.status(200).json({ success: true, data: { superadmin: SUPERADMIN_JID, admins: numbers } });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal membaca admin.', error: error.message });
    }
};

const addAdmin = async (req, res) => {
    try {
        const phone = String(req.body?.phone || '').trim();
        const targetJid = normalizeToJid(phone);
        if (!targetJid) return res.status(400).json({ success: false, message: 'phone tidak valid.' });
        const admins = await addAdminJid(targetJid);
        return res.status(201).json({ success: true, message: 'Admin runtime ditambahkan.', data: { totalDynamicAdmins: admins.length } });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal tambah admin.', error: error.message });
    }
};

const deleteAdmin = async (req, res) => {
    try {
        const phone = String(req.params.phone || '').trim();
        const targetJid = normalizeToJid(phone);
        if (!targetJid) return res.status(400).json({ success: false, message: 'phone tidak valid.' });
        if (targetJid === SUPERADMIN_JID) return res.status(400).json({ success: false, message: 'Superadmin utama tidak bisa dihapus.' });

        const result = await removeAdminJid(phone);
        if (!result.removed) return res.status(404).json({ success: false, message: 'Admin tidak ditemukan.' });

        return res.status(200).json({ success: true, message: 'Admin runtime dihapus.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal hapus admin.', error: error.message });
    }
};

const getSettingsOverview = async (req, res) => {
    try {
        const settings = await getAdminSettings();
        return res.status(200).json({
            success: true,
            data: {
                GREETING_MSG: settings.GREETING_MSG || '',
                SESSION_END_TEXT: settings.SESSION_END_TEXT || '',
                TIMEOUT_SEC: settings.TIMEOUT_SEC || '',
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal membaca settings.', error: error.message });
    }
};

const disabledWriteResponse = (res) => {
    return res.status(503).json({
        success: false,
        message: 'Endpoint write settings dinonaktifkan sementara selama migrasi ke Backend NestJS.',
    });
};

const updateSessionEndText = async (req, res) => disabledWriteResponse(res);
const updateTimeoutText = async (req, res) => disabledWriteResponse(res);
const updateTimeoutSeconds = async (req, res) => disabledWriteResponse(res);
const updateMainMenuEnabled = async (req, res) => disabledWriteResponse(res);
const reorderMainMenu = async (req, res) => disabledWriteResponse(res);
const updateSubMenuFlowMode = async (req, res) => disabledWriteResponse(res);
const updateSubMenuAwaitTimeout = async (req, res) => disabledWriteResponse(res);
const updateSubMenuSuccessReply = async (req, res) => disabledWriteResponse(res);

const resetSession = async (req, res) => {
    try {
        const sessionKey = String(req.params.sessionKey || '').trim();
        if (!sessions[sessionKey]) {
            return res.status(404).json({ success: false, message: 'Session tidak ditemukan.' });
        }

        endSession(sessionKey);
        return res.status(200).json({ success: true, message: 'Session berhasil direset.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal reset session.', error: error.message });
    }
};

const getStatByRange = async (req, res) => {
    return res.status(503).json({
        success: false,
        message: 'Endpoint statistik dinonaktifkan sementara selama migrasi ke Backend NestJS.',
    });
};

module.exports = {
    getAdminCommands,
    listAdmins,
    addAdmin,
    deleteAdmin,
    getSettingsOverview,
    updateSessionEndText,
    updateTimeoutText,
    updateTimeoutSeconds,
    updateMainMenuEnabled,
    reorderMainMenu,
    updateSubMenuFlowMode,
    updateSubMenuAwaitTimeout,
    updateSubMenuSuccessReply,
    resetSession,
    getStatByRange,
};
