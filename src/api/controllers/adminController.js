const { SUPERADMIN_JID } = require('../../../settings');
const { loadCmsData, saveCmsData, getMainMenu, setSubMenuFlowMode, setSubMenuAwaitTimeout, setSubMenuSuccessReply, getSubMenuSettingTargets } = require('../../services/cmsService');
const { normalizeToJid, displayAdminNumber } = require('../../services/lidService');
const { addAdminJid, listAdminJids, removeAdminJid } = require('../../services/adminService');
const { countWargaChatsInLastDays, countWargaSessionsInLastDays } = require('../../services/analyticsService');
const { sessions } = require('../../controllers/wargaController');

const RANGE_TO_DAYS = { '1d': 1, '7d': 7, '30d': 30, '1y': 365 };

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
        return res.status(201).json({ success: true, message: 'Admin ditambahkan.', data: { totalDynamicAdmins: admins.length } });
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

        return res.status(200).json({ success: true, message: 'Admin dihapus.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal hapus admin.', error: error.message });
    }
};

const getSettingsOverview = async (req, res) => {
    try {
        const cmsData = await loadCmsData();
        const subTargets = getSubMenuSettingTargets(cmsData);
        return res.status(200).json({
            success: true,
            data: {
                greetingMessage: cmsData.greetingMessage,
                timeoutText: cmsData.timeoutText,
                sessionEndText: cmsData.sessionEndText,
                timeoutSeconds: cmsData.timeoutSeconds,
                mainMenu: cmsData.mainMenu,
                subMenuSettings: subTargets,
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal membaca settings.', error: error.message });
    }
};

const updateSessionEndText = async (req, res) => {
    try {
        const value = String(req.body?.value || '').trim();
        if (!value) return res.status(400).json({ success: false, message: 'value wajib diisi.' });
        const cmsData = await loadCmsData();
        cmsData.sessionEndText = value;
        await saveCmsData(cmsData);
        return res.status(200).json({ success: true, message: 'sessionEndText diperbarui.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal update sessionEndText.', error: error.message });
    }
};

const updateTimeoutText = async (req, res) => {
    try {
        const value = String(req.body?.value || '').trim();
        if (!value) return res.status(400).json({ success: false, message: 'value wajib diisi.' });
        const cmsData = await loadCmsData();
        cmsData.timeoutText = value;
        await saveCmsData(cmsData);
        return res.status(200).json({ success: true, message: 'timeoutText diperbarui.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal update timeoutText.', error: error.message });
    }
};

const updateTimeoutSeconds = async (req, res) => {
    try {
        const value = Number(req.body?.value);
        if (!Number.isInteger(value) || value < 10 || value > 3600) {
            return res.status(400).json({ success: false, message: 'value harus angka 10-3600.' });
        }
        const cmsData = await loadCmsData();
        cmsData.timeoutSeconds = value;
        await saveCmsData(cmsData);
        return res.status(200).json({ success: true, message: 'timeoutSeconds diperbarui.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal update timeoutSeconds.', error: error.message });
    }
};

const updateMainMenuEnabled = async (req, res) => {
    try {
        const menuId = String(req.params.menuId || '').trim();
        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, message: 'enabled harus boolean.' });

        const cmsData = await loadCmsData();
        const menu = getMainMenu(cmsData).find((item) => item.id === menuId);
        if (!menu) return res.status(404).json({ success: false, message: 'menuId tidak ditemukan.' });

        menu.enabled = enabled;
        await saveCmsData(cmsData);
        return res.status(200).json({ success: true, message: 'Status menu diperbarui.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal update status menu.', error: error.message });
    }
};

const reorderMainMenu = async (req, res) => {
    try {
        const order = req.body?.order;
        if (!Array.isArray(order)) return res.status(400).json({ success: false, message: 'order harus array menuId.' });

        const cmsData = await loadCmsData();
        const mainMenu = getMainMenu(cmsData);
        if (order.length !== mainMenu.length) {
            return res.status(400).json({ success: false, message: 'Jumlah order harus sama dengan jumlah menu.' });
        }

        const byId = new Map(mainMenu.map((item) => [item.id, item]));
        const reordered = [];
        for (const id of order) {
            if (!byId.has(id)) return res.status(400).json({ success: false, message: `menuId tidak valid: ${id}` });
            reordered.push(byId.get(id));
        }

        if (new Set(order).size !== order.length) {
            return res.status(400).json({ success: false, message: 'order tidak boleh duplikat.' });
        }

        cmsData.mainMenu = reordered;
        await saveCmsData(cmsData);
        return res.status(200).json({ success: true, message: 'Urutan menu diperbarui.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal reorder menu.', error: error.message });
    }
};

const updateSubMenuFlowMode = async (req, res) => {
    try {
        const subMenuId = String(req.params.subMenuId || '').trim();
        const mode = String(req.body?.mode || '').trim();
        if (!['close', 'await_reply'].includes(mode)) {
            return res.status(400).json({ success: false, message: 'mode harus close atau await_reply.' });
        }

        const cmsData = await loadCmsData();
        const ok = setSubMenuFlowMode(cmsData, subMenuId, mode);
        if (!ok) return res.status(404).json({ success: false, message: 'subMenuId tidak ditemukan atau bukan leaf.' });

        await saveCmsData(cmsData);
        return res.status(200).json({ success: true, message: 'Flow mode submenu diperbarui.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal update flow mode submenu.', error: error.message });
    }
};

const updateSubMenuAwaitTimeout = async (req, res) => {
    try {
        const subMenuId = String(req.params.subMenuId || '').trim();
        const seconds = Number(req.body?.seconds);
        if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
            return res.status(400).json({ success: false, message: 'seconds harus angka 30-3600.' });
        }

        const cmsData = await loadCmsData();
        const ok = setSubMenuAwaitTimeout(cmsData, subMenuId, seconds);
        if (!ok) return res.status(404).json({ success: false, message: 'subMenuId tidak ditemukan atau bukan leaf.' });

        await saveCmsData(cmsData);
        return res.status(200).json({ success: true, message: 'Timeout submenu diperbarui.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal update timeout submenu.', error: error.message });
    }
};

const updateSubMenuSuccessReply = async (req, res) => {
    try {
        const subMenuId = String(req.params.subMenuId || '').trim();
        const message = String(req.body?.message || '').trim();
        if (!message) return res.status(400).json({ success: false, message: 'message wajib diisi.' });

        const cmsData = await loadCmsData();
        const ok = setSubMenuSuccessReply(cmsData, subMenuId, message);
        if (!ok) return res.status(404).json({ success: false, message: 'subMenuId tidak ditemukan atau bukan leaf.' });

        await saveCmsData(cmsData);
        return res.status(200).json({ success: true, message: 'Success reply submenu diperbarui.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal update success reply submenu.', error: error.message });
    }
};

const resetSession = async (req, res) => {
    try {
        const sessionKey = String(req.params.sessionKey || '').trim();
        if (!sessions.has(sessionKey)) {
            return res.status(404).json({ success: false, message: 'Session tidak ditemukan.' });
        }
        sessions.delete(sessionKey);
        return res.status(200).json({ success: true, message: 'Session berhasil direset.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal reset session.', error: error.message });
    }
};

const getStatByRange = async (req, res) => {
    try {
        const metric = String(req.params.metric || '').trim();
        const range = String(req.query.range || '7d').toLowerCase();
        const days = RANGE_TO_DAYS[range];
        if (!days) return res.status(400).json({ success: false, message: 'range tidak valid. Gunakan 1d/7d/30d/1y.' });

        if (metric === 'totalchat') {
            const total = await countWargaChatsInLastDays(days);
            return res.status(200).json({ success: true, data: { metric, range, days, total } });
        }

        if (metric === 'totalsesi') {
            const total = await countWargaSessionsInLastDays(days);
            return res.status(200).json({ success: true, data: { metric, range, days, total } });
        }

        return res.status(400).json({ success: false, message: 'metric tidak valid. Gunakan totalchat/totalsesi.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal membaca statistik.', error: error.message });
    }
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
