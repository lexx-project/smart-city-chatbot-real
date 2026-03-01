const { SUPERADMIN_JID, ADMIN_FLOW_TIMEOUT_MS } = require('../../settings');
const {
    loadCmsData,
    saveCmsData,
    getMainMenu,
    getSubMenuSettingTargets,
    setSubMenuFlowMode,
    setSubMenuAwaitTimeout,
    setSubMenuSuccessReply,
    resolveMenuNode,
    FLOW_MODE,
} = require('../services/cmsService');
const { normalizeToJid, displayAdminNumber } = require('../services/lidService');
const { isAdminJid, addAdminJid, listAdminJids, removeAdminJid } = require('../services/adminService');
const { countWargaChatsInLastDays, countWargaSessionsInLastDays } = require('../services/analyticsService');
const { updateBotProfilePictureFromMessage, removeBotProfilePicture } = require('../services/botProfileService');
const { unwrapMessage } = require('../middlewares/messageMiddleware');

const adminSessions = new Map();

const ADMIN_STATE = {
    IDLE: 'IDLE',
    SETTINGS_MENU: 'SETTINGS_MENU',
    WAITING_SESSION_END_TEXT: 'WAITING_SESSION_END_TEXT',
    WAITING_TIMEOUT_TEXT: 'WAITING_TIMEOUT_TEXT',
    WAITING_TIMEOUT_SECONDS: 'WAITING_TIMEOUT_SECONDS',
    WAITING_MENU_TOGGLE: 'WAITING_MENU_TOGGLE',
    WAITING_MENU_REORDER: 'WAITING_MENU_REORDER',
    WAITING_FLOW_MAIN_MENU: 'WAITING_FLOW_MAIN_MENU',
    WAITING_FLOW_SUB_MENU: 'WAITING_FLOW_SUB_MENU',
    WAITING_FLOW_MODE_VALUE: 'WAITING_FLOW_MODE_VALUE',
    WAITING_FLOW_TARGET_TIMEOUT: 'WAITING_FLOW_TARGET_TIMEOUT',
    WAITING_FLOW_TIMEOUT_VALUE: 'WAITING_FLOW_TIMEOUT_VALUE',
    WAITING_FLOW_SUCCESS_VALUE: 'WAITING_FLOW_SUCCESS_VALUE',
    WAITING_STATS_RANGE: 'WAITING_STATS_RANGE',
    WAITING_BOT_PP_IMAGE: 'WAITING_BOT_PP_IMAGE',
};

const getAdminSession = (jid) => adminSessions.get(jid) || { state: ADMIN_STATE.IDLE, timeoutId: null };

const setAdminSession = (jid, patch = {}) => {
    const current = getAdminSession(jid);
    adminSessions.set(jid, { ...current, ...patch });
};

const resetAdminSession = (jid) => {
    adminSessions.set(jid, {
        state: ADMIN_STATE.IDLE,
        timeoutId: null,
        targetSubMenuId: null,
        targetList: null,
        flowChoices: null,
        flowAction: null,
        statsType: null,
    });
};

const clearAdminFlowTimer = (jid) => {
    const session = adminSessions.get(jid);
    if (!session?.timeoutId) return;
    clearTimeout(session.timeoutId);
};

const scheduleAdminFlowTimeout = (sock, jid) => {
    clearAdminFlowTimer(jid);

    const timeoutId = setTimeout(async () => {
        try {
            resetAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Timeout 60 detik. Proses /setting dibatalkan otomatis.' });
        } catch (error) {
            console.error('[ADMIN_TIMEOUT_ERROR]', error);
        }
    }, ADMIN_FLOW_TIMEOUT_MS);

    setAdminSession(jid, { timeoutId });
};

const formatMainMenuStatus = (mainMenu) => {
    return mainMenu
        .map((item, index) => `${index + 1}. ${item.title} (${item.enabled === false ? 'nonaktif' : 'aktif'}) [${item.id}]`)
        .join('\n');
};

const formatSubMenuTargets = (targets) => {
    return targets
        .map((item, index) => {
            const modeLabel = item.flowMode === FLOW_MODE.AWAIT_REPLY ? 'Butuh balasan warga' : 'Langsung selesai';
            return `${index + 1}. ${item.title} [${item.id}] (${modeLabel}, timeout=${item.awaitTimeoutSeconds} detik)`;
        })
        .join('\n');
};

const formatSimpleChoices = (choices = []) => {
    return choices.map((item, index) => `${index + 1}. ${item.title}`).join('\n');
};

const parseSubMenuTarget = (text, targetList = []) => {
    const raw = String(text || '').trim();
    if (!raw) return null;

    if (/^\d+$/.test(raw)) {
        const index = Number(raw) - 1;
        return targetList[index] || null;
    }

    return targetList.find((item) => item.id === raw) || null;
};

const parseChoice = (text, choices = []) => {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
        const index = Number(raw) - 1;
        return choices[index] || null;
    }
    return choices.find((item) => item.id === raw) || null;
};

const parseFlowModeInput = (text) => {
    const raw = String(text || '').trim().toLowerCase();
    if (raw === '1') return FLOW_MODE.CLOSE;
    if (raw === '2') return FLOW_MODE.AWAIT_REPLY;
    if (['close', 'selesai', 'langsung'].includes(raw)) return FLOW_MODE.CLOSE;
    if (['await_reply', 'await', 'reply', 'balas'].includes(raw)) return FLOW_MODE.AWAIT_REPLY;
    if (['langsung selesai'].includes(raw)) return FLOW_MODE.CLOSE;
    if (['butuh balasan', 'menunggu balasan', 'tunggu balasan warga'].includes(raw)) return FLOW_MODE.AWAIT_REPLY;
    return null;
};

const RANGE_OPTIONS = {
    '1': 1,
    '2': 7,
    '3': 30,
    '4': 365,
};

const formatRangeLabel = (days) => {
    if (days === 1) return '1 hari';
    if (days === 7) return '7 hari';
    if (days === 30) return '30 hari';
    return '1 tahun';
};

const sendStatsRangeMenu = async (sock, jid, title) => {
    await sock.sendMessage(jid, {
        text: [
            title,
            '',
            '1. 1 hari',
            '2. 7 hari',
            '3. 30 hari',
            '4. 1 tahun',
            '',
            'Balas 1-4.',
        ].join('\n'),
    });
};

const hasAwaitReplyLeaf = (cmsData, id, visited = new Set()) => {
    const key = String(id || '');
    if (!key || visited.has(key)) return false;
    visited.add(key);

    const node = resolveMenuNode(cmsData, key);
    if (!node) return false;
    if (node.kind === 'leaf') return node.flowMode === FLOW_MODE.AWAIT_REPLY;

    return (node.nextMenu || []).some((item) => hasAwaitReplyLeaf(cmsData, item.id, new Set(visited)));
};

const sendSettingsMenu = async (sock, jid, cmsData) => {
    const globalTimeout = Number(cmsData?.timeoutSeconds) > 0 ? Number(cmsData.timeoutSeconds) : 30;
    const mainMenu = getMainMenu(cmsData);
    const menuEnabledCount = mainMenu.filter((item) => item.enabled !== false).length;
    const subMenuTargets = getSubMenuSettingTargets(cmsData);

    const text = [
        'Panel Pengaturan Admin',
        '',
        `1. Ubah Pesan Penutup (${cmsData?.sessionEndText ? 'aktif' : 'default'})`,
        `2. Ubah Pesan Timeout (${cmsData?.timeoutText ? 'aktif' : 'default'})`,
        `3. Ubah Timeout Global (${globalTimeout} detik)`,
        `4. Aktif/Nonaktifkan Menu (${menuEnabledCount}/${mainMenu.length} aktif)`,
        '5. Ubah Urutan Menu',
        `6. Atur Jenis Respon SubMenu (${subMenuTargets.length})`,
        '7. Atur Durasi Tunggu Balasan SubMenu',
        '8. Atur Pesan Saat Balasan Diterima',
        '9. Ubah Foto Profil Bot',
        '',
        'Balas angka 1-9. Ketik /batal untuk keluar.',
    ].join('\n');

    await sock.sendMessage(jid, { text });
    setAdminSession(jid, { state: ADMIN_STATE.SETTINGS_MENU, targetSubMenuId: null, targetList: null, flowAction: null });
    scheduleAdminFlowTimeout(sock, jid);
};

const handleSettingsState = async (sock, jid, text, session, cmsData) => {
    if (session.state === ADMIN_STATE.WAITING_SESSION_END_TEXT) {
        cmsData.sessionEndText = text;
        await saveCmsData(cmsData);
        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        await sock.sendMessage(jid, { text: 'Berhasil memperbarui pesan penutup.' });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_TIMEOUT_TEXT) {
        cmsData.timeoutText = text;
        await saveCmsData(cmsData);
        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        await sock.sendMessage(jid, { text: 'Berhasil memperbarui pesan timeout.' });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_TIMEOUT_SECONDS) {
        const seconds = Number(text);
        if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Nilai tidak valid. Masukkan angka 10-3600 detik.' });
            return true;
        }

        cmsData.timeoutSeconds = seconds;
        await saveCmsData(cmsData);
        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        await sock.sendMessage(jid, { text: `Berhasil. Timeout sesi warga diubah ke ${seconds} detik.` });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_MENU_TOGGLE) {
        const match = text.trim().match(/^(\d+)\s+(\S+)$/);
        if (!match) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Format salah. Gunakan: <nomor_menu> <on/off>. Contoh: 2 off' });
            return true;
        }

        const index = Number(match[1]) - 1;
        const action = match[2].toLowerCase();
        const mainMenu = getMainMenu(cmsData);
        const target = mainMenu[index];
        if (!target) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Nomor menu tidak ditemukan.' });
            return true;
        }

        let enabled = null;
        if (['on', 'aktif', 'enable', '1'].includes(action)) enabled = true;
        if (['off', 'nonaktif', 'disable', '0'].includes(action)) enabled = false;
        if (enabled === null) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Aksi tidak valid. Gunakan on/off.' });
            return true;
        }

        target.enabled = enabled;
        cmsData.mainMenu = mainMenu;
        await saveCmsData(cmsData);
        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        await sock.sendMessage(jid, { text: `Berhasil. Menu "${target.title}" sekarang ${enabled ? 'aktif' : 'nonaktif'}.` });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_MENU_REORDER) {
        const mainMenu = getMainMenu(cmsData);
        const nums = text
            .split(/[,\s]+/)
            .map((item) => Number(item.trim()))
            .filter((item) => Number.isInteger(item));

        const isValidLength = nums.length === mainMenu.length;
        const allInRange = nums.every((num) => num >= 1 && num <= mainMenu.length);
        const unique = new Set(nums).size === nums.length;
        if (!isValidLength || !allInRange || !unique) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, {
                text: `Urutan tidak valid. Masukkan tepat ${mainMenu.length} angka unik. Contoh: 2,1,3`,
            });
            return true;
        }

        cmsData.mainMenu = nums.map((num) => mainMenu[num - 1]);
        await saveCmsData(cmsData);
        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        await sock.sendMessage(jid, { text: 'Berhasil. Urutan menu utama telah diperbarui.' });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_FLOW_MAIN_MENU) {
        const target = parseChoice(text, session.flowChoices || []);
        if (!target) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Pilihan tidak valid. Balas nomor/id.' });
            return true;
        }

        const node = resolveMenuNode(cmsData, target.id);
        if (!node) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Menu tidak ditemukan.' });
            return true;
        }

        if (node.kind === 'menu') {
            let nextChoices = node.nextMenu;
            if (session.flowAction === 'success') {
                nextChoices = (node.nextMenu || []).filter((item) => hasAwaitReplyLeaf(cmsData, item.id));
                if (!nextChoices.length) {
                    scheduleAdminFlowTimeout(sock, jid);
                    await sock.sendMessage(jid, { text: 'Tidak ada submenu mode butuh balasan di menu ini.' });
                    return true;
                }
            }

            setAdminSession(jid, {
                state: ADMIN_STATE.WAITING_FLOW_SUB_MENU,
                flowChoices: nextChoices,
                targetSubMenuId: null,
            });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, {
                text: ['Pilih submenu:', formatSimpleChoices(nextChoices)].join('\n\n'),
            });
            return true;
        }

        if (session.flowAction === 'success') {
            if (node.flowMode !== FLOW_MODE.AWAIT_REPLY) {
                scheduleAdminFlowTimeout(sock, jid);
                await sock.sendMessage(jid, { text: 'Submenu ini bukan mode butuh balasan.' });
                return true;
            }
            setAdminSession(jid, { state: ADMIN_STATE.WAITING_FLOW_SUCCESS_VALUE, targetSubMenuId: target.id, flowChoices: null });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: `Kirim pesan sukses baru.\nTarget: ${target.title}` });
            return true;
        }

        setAdminSession(jid, { state: ADMIN_STATE.WAITING_FLOW_MODE_VALUE, targetSubMenuId: target.id, flowChoices: null });
        scheduleAdminFlowTimeout(sock, jid);
        await sock.sendMessage(jid, {
            text: [
                '1. Langsung selesai',
                '2. Butuh balasan warga',
                `Target: ${target.title}`,
                'Balas 1/2',
            ].join('\n'),
        });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_FLOW_SUB_MENU) {
        const target = parseChoice(text, session.flowChoices || []);
        if (!target) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Pilihan tidak valid. Balas nomor/id.' });
            return true;
        }

        const node = resolveMenuNode(cmsData, target.id);
        if (!node) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Submenu tidak ditemukan.' });
            return true;
        }

        if (node.kind === 'menu') {
            let nextChoices = node.nextMenu;
            if (session.flowAction === 'success') {
                nextChoices = (node.nextMenu || []).filter((item) => hasAwaitReplyLeaf(cmsData, item.id));
                if (!nextChoices.length) {
                    scheduleAdminFlowTimeout(sock, jid);
                    await sock.sendMessage(jid, { text: 'Tidak ada submenu mode butuh balasan di level ini.' });
                    return true;
                }
            }

            setAdminSession(jid, {
                state: ADMIN_STATE.WAITING_FLOW_SUB_MENU,
                flowChoices: nextChoices,
                targetSubMenuId: null,
            });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, {
                text: ['Pilih submenu:', formatSimpleChoices(nextChoices)].join('\n\n'),
            });
            return true;
        }

        if (session.flowAction === 'success') {
            if (node.flowMode !== FLOW_MODE.AWAIT_REPLY) {
                scheduleAdminFlowTimeout(sock, jid);
                await sock.sendMessage(jid, { text: 'Submenu ini bukan mode butuh balasan.' });
                return true;
            }
            setAdminSession(jid, { state: ADMIN_STATE.WAITING_FLOW_SUCCESS_VALUE, targetSubMenuId: target.id, flowChoices: null });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: `Kirim pesan sukses baru.\nTarget: ${target.title}` });
            return true;
        }

        setAdminSession(jid, { state: ADMIN_STATE.WAITING_FLOW_MODE_VALUE, targetSubMenuId: target.id, flowChoices: null });
        scheduleAdminFlowTimeout(sock, jid);
        await sock.sendMessage(jid, {
            text: [
                '1. Langsung selesai',
                '2. Butuh balasan warga',
                `Target: ${target.title}`,
                'Balas 1/2',
            ].join('\n'),
        });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_FLOW_MODE_VALUE) {
        const mode = parseFlowModeInput(text);
        if (!mode || !session.targetSubMenuId) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, {
                text: 'Pilihan tidak valid. Balas 1 atau 2.',
            });
            return true;
        }

        const updated = setSubMenuFlowMode(cmsData, session.targetSubMenuId, mode);
        if (!updated) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Submenu target tidak bisa diubah.' });
            return true;
        }

        await saveCmsData(cmsData);
        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        const modeLabel = mode === FLOW_MODE.AWAIT_REPLY ? 'Butuh balasan warga' : 'Langsung selesai';
        await sock.sendMessage(jid, { text: `Berhasil. Cara selesai ${session.targetSubMenuId} diubah ke: ${modeLabel}.` });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_FLOW_TARGET_TIMEOUT) {
        const target = parseSubMenuTarget(text, session.targetList || []);
        if (!target) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Submenu tidak valid. Balas nomor/id yang ada di daftar.' });
            return true;
        }

        setAdminSession(jid, { state: ADMIN_STATE.WAITING_FLOW_TIMEOUT_VALUE, targetSubMenuId: target.id });
        scheduleAdminFlowTimeout(sock, jid);
        await sock.sendMessage(jid, { text: `Masukkan timeout baru untuk ${target.id} (detik, 30-3600).` });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_FLOW_TIMEOUT_VALUE) {
        const seconds = Number(text);
        if (!session.targetSubMenuId || !Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Timeout tidak valid. Masukkan angka 30-3600.' });
            return true;
        }

        const updated = setSubMenuAwaitTimeout(cmsData, session.targetSubMenuId, seconds);
        if (!updated) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Submenu target tidak bisa diubah.' });
            return true;
        }

        await saveCmsData(cmsData);
        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        await sock.sendMessage(jid, { text: `Berhasil. Timeout ${session.targetSubMenuId} diubah ke ${seconds} detik.` });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_FLOW_SUCCESS_VALUE) {
        if (!session.targetSubMenuId) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Target submenu tidak valid.' });
            return true;
        }

        const updated = setSubMenuSuccessReply(cmsData, session.targetSubMenuId, text);
        if (!updated) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Submenu target tidak bisa diubah.' });
            return true;
        }

        await saveCmsData(cmsData);
        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        await sock.sendMessage(jid, { text: `Berhasil. Pesan sukses ${session.targetSubMenuId} diperbarui.` });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_STATS_RANGE) {
        const days = RANGE_OPTIONS[String(text).trim()];
        if (!days || !session.statsType) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Pilihan tidak valid. Balas 1-4.' });
            return true;
        }

        let total = 0;
        if (session.statsType === 'chat') {
            total = await countWargaChatsInLastDays(days);
            await sock.sendMessage(jid, { text: `Total chat warga (${formatRangeLabel(days)}): ${total}` });
        } else {
            total = await countWargaSessionsInLastDays(days);
            await sock.sendMessage(jid, { text: `Total sesi warga (${formatRangeLabel(days)}): ${total}` });
        }

        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        return true;
    }

    return false;
};

const handleAdminMessage = async (sock, msg, bodyText = '') => {
    const jid = msg.key.remoteJid;
    if (!jid) return false;

    const text = (bodyText || '').trim();
    const normalized = text.toLowerCase();
    const cmsData = await loadCmsData();
    const isAdmin = await isAdminJid(jid, cmsData);
    const session = getAdminSession(jid);

    if (normalized === '/batal') {
        if (!isAdmin) {
            await sock.sendMessage(jid, { text: 'Akses ditolak. Hanya admin yang bisa menggunakan command ini.' });
            return true;
        }
        clearAdminFlowTimer(jid);
        resetAdminSession(jid);
        await sock.sendMessage(jid, { text: 'Proses admin dibatalkan.' });
        return true;
    }

    if (session.state === ADMIN_STATE.WAITING_BOT_PP_IMAGE) {
        if (!isAdmin) {
            await sock.sendMessage(jid, { text: 'Akses ditolak. Hanya admin yang bisa mengubah foto profil bot.' });
            return true;
        }

        if (normalized === 'hapus') {
            try {
                await removeBotProfilePicture(sock);
                clearAdminFlowTimer(jid);
                resetAdminSession(jid);
                await sock.sendMessage(jid, { text: 'Berhasil. Foto profil bot dihapus.' });
            } catch (error) {
                console.error('[BOT_PP_REMOVE_ERROR]', error);
                clearAdminFlowTimer(jid);
                resetAdminSession(jid);
                await sock.sendMessage(jid, { text: 'Gagal hapus foto profil.' });
            }
            return true;
        }

        const rawMessage = unwrapMessage(msg?.message || {});
        const hasImage = !!rawMessage?.imageMessage;
        if (!hasImage) {
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Kirim foto baru, atau ketik hapus.' });
            return true;
        }

        try {
            await updateBotProfilePictureFromMessage(sock, msg);
            clearAdminFlowTimer(jid);
            resetAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Berhasil. Foto profil bot diperbarui.' });
        } catch (error) {
            console.error('[BOT_PP_UPDATE_ERROR]', error);
            clearAdminFlowTimer(jid);
            resetAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Gagal update foto profil.' });
        }
        return true;
    }

    if (!text) return false;

    if (normalized === '/setting') {
        if (!isAdmin) {
            await sock.sendMessage(jid, { text: 'Akses ditolak. Hanya admin yang bisa mengakses /setting.' });
            return true;
        }
        await sendSettingsMenu(sock, jid, cmsData);
        return true;
    }

    if (normalized.startsWith('/addadmin')) {
        if (!isAdmin) {
            await sock.sendMessage(jid, { text: 'Akses ditolak. Hanya admin yang bisa menggunakan /addadmin.' });
            return true;
        }

        const candidate = text.split(/\s+/)[1] || '';
        const targetJid = normalizeToJid(candidate);
        if (!targetJid) {
            await sock.sendMessage(jid, { text: 'Format salah. Gunakan: /addadmin 628xxxxxxxxxx' });
            return true;
        }

        const admins = await addAdminJid(targetJid);
        await sock.sendMessage(jid, { text: `Berhasil menambahkan admin: ${targetJid}\nTotal admin dinamis: ${admins.length}` });
        return true;
    }

    if (normalized === '/listadmin') {
        if (!isAdmin) {
            await sock.sendMessage(jid, { text: 'Akses ditolak. Hanya admin yang bisa menggunakan /listadmin.' });
            return true;
        }

        const admins = await listAdminJids();
        const lines = [];
        for (let index = 0; index < admins.length; index += 1) {
            const numberOnly = await displayAdminNumber(admins[index]);
            lines.push(`${index + 1}. ${numberOnly || '-'}`);
        }
        await sock.sendMessage(jid, { text: `Daftar admin saat ini:\n\n${lines.join('\n')}` });
        return true;
    }

    if (normalized.startsWith('/deladmin')) {
        if (!isAdmin) {
            await sock.sendMessage(jid, { text: 'Akses ditolak. Hanya admin yang bisa menggunakan /deladmin.' });
            return true;
        }

        const candidate = text.split(/\s+/)[1] || '';
        if (!candidate) {
            await sock.sendMessage(jid, { text: 'Format salah. Gunakan: /deladmin 628xxxxxxxxxx' });
            return true;
        }

        const targetJid = normalizeToJid(candidate);
        if (targetJid === SUPERADMIN_JID) {
            await sock.sendMessage(jid, { text: 'Superadmin utama tidak bisa dihapus.' });
            return true;
        }

        const result = await removeAdminJid(candidate);
        if (!result.removed) {
            await sock.sendMessage(jid, { text: 'Nomor admin tidak ditemukan di daftar admin dinamis.' });
            return true;
        }

        await sock.sendMessage(jid, { text: `Berhasil menghapus admin: ${candidate}` });
        return true;
    }

    if (normalized === '/menuadmin') {
        if (!isAdmin) {
            await sock.sendMessage(jid, { text: 'Akses ditolak. Hanya admin yang bisa menggunakan /menuadmin.' });
            return true;
        }

        await sock.sendMessage(jid, {
            text: [
                'Daftar command admin:',
                '',
                '1. /menuadmin',
                '2. /setting',
                '3. /addadmin',
                '4. /listadmin',
                '5. /deladmin',
                '6. /totalchat',
                '7. /totalsesi',
                '8. /batal',
            ].join('\n'),
        });
        return true;
    }

    if (normalized === '/totalchat') {
        if (!isAdmin) {
            await sock.sendMessage(jid, { text: 'Akses ditolak. Hanya admin yang bisa menggunakan /totalchat.' });
            return true;
        }
        setAdminSession(jid, { state: ADMIN_STATE.WAITING_STATS_RANGE, statsType: 'chat' });
        scheduleAdminFlowTimeout(sock, jid);
        await sendStatsRangeMenu(sock, jid, 'Pilih rentang waktu total chat warga:');
        return true;
    }

    if (normalized === '/totalsesi') {
        if (!isAdmin) {
            await sock.sendMessage(jid, { text: 'Akses ditolak. Hanya admin yang bisa menggunakan /totalsesi.' });
            return true;
        }
        setAdminSession(jid, { state: ADMIN_STATE.WAITING_STATS_RANGE, statsType: 'session' });
        scheduleAdminFlowTimeout(sock, jid);
        await sendStatsRangeMenu(sock, jid, 'Pilih rentang waktu total sesi warga:');
        return true;
    }

    if (!isAdmin) return false;

    const handledState = await handleSettingsState(sock, jid, text, session, cmsData);
    if (handledState) return true;

    if (session.state === ADMIN_STATE.SETTINGS_MENU) {
        if (text === '1') {
            setAdminSession(jid, { state: ADMIN_STATE.WAITING_SESSION_END_TEXT });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Kirim teks baru untuk pesan penutup sesi warga.' });
            return true;
        }

        if (text === '2') {
            setAdminSession(jid, { state: ADMIN_STATE.WAITING_TIMEOUT_TEXT });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Kirim teks baru untuk pesan timeout sesi warga.' });
            return true;
        }

        if (text === '3') {
            setAdminSession(jid, { state: ADMIN_STATE.WAITING_TIMEOUT_SECONDS });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Masukkan timeout sesi warga (detik), rentang 10-3600.' });
            return true;
        }

        if (text === '4') {
            const mainMenu = getMainMenu(cmsData);
            setAdminSession(jid, { state: ADMIN_STATE.WAITING_MENU_TOGGLE });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, {
                text: [
                    'Aktif/nonaktifkan menu utama.',
                    '',
                    formatMainMenuStatus(mainMenu),
                    '',
                    'Format balasan: <nomor_menu> <on/off>. Contoh: 2 off',
                ].join('\n'),
            });
            return true;
        }

        if (text === '5') {
            const mainMenu = getMainMenu(cmsData);
            setAdminSession(jid, { state: ADMIN_STATE.WAITING_MENU_REORDER });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, {
                text: [
                    'Ubah urutan menu utama.',
                    '',
                    formatMainMenuStatus(mainMenu),
                    '',
                    `Masukkan urutan baru (${mainMenu.length} angka) dipisah koma. Contoh: 2,1,3`,
                ].join('\n'),
            });
            return true;
        }

        if (text === '6') {
            const mainChoices = getMainMenu(cmsData)
                .filter((item) => item?.id)
                .map((item) => ({ id: item.id, title: item.title || item.id }));
            if (!mainChoices.length) {
                await sock.sendMessage(jid, { text: 'Menu utama belum ada.' });
                return true;
            }

            setAdminSession(jid, {
                state: ADMIN_STATE.WAITING_FLOW_MAIN_MENU,
                flowChoices: mainChoices,
                targetSubMenuId: null,
                flowAction: 'mode',
            });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, {
                text: ['Pilih menu:', formatSimpleChoices(mainChoices)].join('\n\n'),
            });
            return true;
        }

        if (text === '8') {
            const mainChoices = getMainMenu(cmsData)
                .filter((item) => item?.id)
                .filter((item) => hasAwaitReplyLeaf(cmsData, item.id))
                .map((item) => ({ id: item.id, title: item.title || item.id }));
            if (!mainChoices.length) {
                await sock.sendMessage(jid, { text: 'Belum ada menu dengan mode butuh balasan.' });
                return true;
            }

            setAdminSession(jid, {
                state: ADMIN_STATE.WAITING_FLOW_MAIN_MENU,
                flowChoices: mainChoices,
                targetSubMenuId: null,
                flowAction: 'success',
            });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, {
                text: ['Pilih menu:', formatSimpleChoices(mainChoices)].join('\n\n'),
            });
            return true;
        }

        if (text === '7') {
            const targets = getSubMenuSettingTargets(cmsData);
            if (!targets.length) {
                await sock.sendMessage(jid, { text: 'Belum ada submenu leaf yang bisa diatur.' });
                return true;
            }

            setAdminSession(jid, { state: ADMIN_STATE.WAITING_FLOW_TARGET_TIMEOUT, targetList: targets, targetSubMenuId: null });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, {
                text: ['Pilih submenu untuk durasi:', '', formatSubMenuTargets(targets)].join('\n'),
            });
            return true;
        }

        if (text === '9') {
            setAdminSession(jid, { state: ADMIN_STATE.WAITING_BOT_PP_IMAGE });
            scheduleAdminFlowTimeout(sock, jid);
            await sock.sendMessage(jid, { text: 'Kirim foto baru, atau ketik hapus.' });
            return true;
        }

        scheduleAdminFlowTimeout(sock, jid);
        await sock.sendMessage(jid, { text: 'Pilihan tidak valid. Balas angka 1-9.' });
        return true;
    }

    return false;
};

module.exports = {
    handleAdminMessage,
    SUPERADMIN_JID,
};
