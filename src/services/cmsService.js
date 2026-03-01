const fs = require('fs/promises');
const path = require('path');
const { DEFAULT_WARGA_TIMEOUT_SECONDS } = require('../../settings');

const CMS_DATA_PATH = path.join(__dirname, '../config/cms-data.json');
const DEFAULT_TIMEOUT_TEXT = 'Terima kasih telah menghubungi kami. Sesi Anda telah berakhir karena tidak ada aktivitas. Silakan kirim pesan lagi untuk memulai sesi baru.';
const DEFAULT_SESSION_END_TEXT = 'Terima kasih sudah menggunakan layanan Smart Public Service. Sampai jumpa.';
const DEFAULT_AWAIT_TIMEOUT_SECONDS = 180;
const DEFAULT_AWAIT_SUCCESS_REPLY = 'Berhasil. Data Anda sudah kami terima.';

const FLOW_MODE = {
    CLOSE: 'close',
    AWAIT_REPLY: 'await_reply',
};

const normalizeFlowMode = (value = '') => {
    const normalized = String(value).trim().toLowerCase();
    if (normalized === FLOW_MODE.AWAIT_REPLY) return FLOW_MODE.AWAIT_REPLY;
    return FLOW_MODE.CLOSE;
};

const loadCmsData = async () => {
    const raw = await fs.readFile(CMS_DATA_PATH, 'utf-8');
    return JSON.parse(raw);
};

const saveCmsData = async (data) => {
    await fs.writeFile(CMS_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
};

const getMainMenu = (cmsData) => (Array.isArray(cmsData?.mainMenu) ? cmsData.mainMenu : []);

const getEnabledMainMenu = (cmsData) => getMainMenu(cmsData).filter((item) => item?.enabled !== false);

const getTimeoutSeconds = (cmsData) => {
    const value = Number(cmsData?.timeoutSeconds);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_WARGA_TIMEOUT_SECONDS;
};

const getTimeoutText = (cmsData) => cmsData?.timeoutText || DEFAULT_TIMEOUT_TEXT;

const getSessionEndText = (cmsData) => cmsData?.sessionEndText || DEFAULT_SESSION_END_TEXT;

const getAwaitTimeoutSeconds = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AWAIT_TIMEOUT_SECONDS;
};

const normalizeNextMenu = (nextMenu = []) => {
    if (!Array.isArray(nextMenu)) return [];
    return nextMenu
        .filter((row) => row && row.id)
        .map((row) => ({ id: row.id, title: row.title || row.id }));
};

const resolveMenuNode = (cmsData, menuId) => {
    const subMenus = cmsData?.subMenus || {};
    const menuData = subMenus?.[menuId];
    if (!menuData) return null;

    if (typeof menuData === 'string') {
        return {
            kind: 'leaf',
            text: menuData,
            flowMode: FLOW_MODE.CLOSE,
            awaitTimeoutSeconds: DEFAULT_AWAIT_TIMEOUT_SECONDS,
            successReply: DEFAULT_AWAIT_SUCCESS_REPLY,
        };
    }

    const nextMenu = normalizeNextMenu(menuData?.nextMenu);
    if (nextMenu.length > 0) {
        return {
            kind: 'menu',
            text: menuData?.text || 'Silakan pilih opsi lanjutan:',
            nextMenu,
        };
    }

    return {
        kind: 'leaf',
        text: menuData?.text || '',
        flowMode: normalizeFlowMode(menuData?.flowMode || menuData?.mode),
        awaitTimeoutSeconds: getAwaitTimeoutSeconds(menuData?.awaitTimeoutSeconds),
        successReply: menuData?.successReply || DEFAULT_AWAIT_SUCCESS_REPLY,
    };
};

const ensureLeafSubMenuObject = (cmsData, menuId) => {
    const subMenus = cmsData?.subMenus || {};
    const current = subMenus?.[menuId];
    if (!current) return null;
    if (typeof current === 'string') {
        subMenus[menuId] = {
            text: current,
            flowMode: FLOW_MODE.CLOSE,
            awaitTimeoutSeconds: DEFAULT_AWAIT_TIMEOUT_SECONDS,
            successReply: DEFAULT_AWAIT_SUCCESS_REPLY,
        };
        cmsData.subMenus = subMenus;
        return subMenus[menuId];
    }
    if (Array.isArray(current?.nextMenu) && current.nextMenu.length > 0) return null;
    return current;
};

const buildMenuTitleIndex = (cmsData) => {
    const map = new Map();
    for (const item of getMainMenu(cmsData)) {
        if (item?.id && item?.title) map.set(item.id, item.title);
    }

    const subMenus = cmsData?.subMenus || {};
    for (const value of Object.values(subMenus)) {
        if (!value || typeof value === 'string') continue;
        const nextMenu = Array.isArray(value.nextMenu) ? value.nextMenu : [];
        for (const row of nextMenu) {
            if (row?.id && row?.title) map.set(row.id, row.title);
        }
    }

    return map;
};

const getSubMenuSettingTargets = (cmsData) => {
    const subMenus = cmsData?.subMenus || {};
    const titleIndex = buildMenuTitleIndex(cmsData);
    const targets = [];

    for (const key of Object.keys(subMenus)) {
        const node = resolveMenuNode(cmsData, key);
        if (!node || node.kind !== 'leaf') continue;

        targets.push({
            id: key,
            title: titleIndex.get(key) || key,
            flowMode: node.flowMode,
            awaitTimeoutSeconds: node.awaitTimeoutSeconds,
            successReply: node.successReply,
        });
    }

    return targets.sort((a, b) => a.id.localeCompare(b.id));
};

const setSubMenuFlowMode = (cmsData, menuId, flowMode) => {
    const target = ensureLeafSubMenuObject(cmsData, menuId);
    if (!target) return false;
    target.flowMode = normalizeFlowMode(flowMode);
    return true;
};

const setSubMenuAwaitTimeout = (cmsData, menuId, seconds) => {
    const target = ensureLeafSubMenuObject(cmsData, menuId);
    if (!target) return false;
    target.awaitTimeoutSeconds = getAwaitTimeoutSeconds(seconds);
    return true;
};

const setSubMenuSuccessReply = (cmsData, menuId, successReply) => {
    const target = ensureLeafSubMenuObject(cmsData, menuId);
    if (!target) return false;
    target.successReply = String(successReply || '').trim() || DEFAULT_AWAIT_SUCCESS_REPLY;
    return true;
};

module.exports = {
    loadCmsData,
    saveCmsData,
    getMainMenu,
    getEnabledMainMenu,
    getTimeoutSeconds,
    getTimeoutText,
    getSessionEndText,
    resolveMenuNode,
    getSubMenuSettingTargets,
    setSubMenuFlowMode,
    setSubMenuAwaitTimeout,
    setSubMenuSuccessReply,
    FLOW_MODE,
};
