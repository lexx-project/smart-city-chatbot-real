const {
    loadCmsData,
    getEnabledMainMenu,
    getTimeoutSeconds,
    getTimeoutText,
    getSessionEndText,
    resolveMenuNode,
    FLOW_MODE,
} = require('../services/cmsService');
const { isAdminJid } = require('../services/adminService');
const { recordWargaChat, recordWargaSessionStart } = require('../services/analyticsService');
const {
    sessions,
    registerAliasesForJid,
    resolveSessionContext,
    createSession,
    deleteSession,
    scheduleSessionTimeout,
} = require('../services/wargaSessionService');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendTextMenu = async (sock, jid, textBlock, menuArray, session) => {
    let message = `${textBlock}\n\n`;
    const optionsMap = {};

    menuArray.forEach((item, index) => {
        const num = String(index + 1);
        message += `*${num}.* ${item.title}\n`;
        optionsMap[num] = item.id;
    });

    message += '\n👉 *Balas dengan angka (contoh: 1) untuk memilih.*';
    session.currentOptions = optionsMap;

    await sock.sendMessage(jid, { text: message });
};

const endSession = async (sock, sessionKey, replyJid, sendTimeoutMessage = false, cmsData = null) => {
    deleteSession(sessionKey);

    if (sendTimeoutMessage) {
        await sock.sendMessage(replyJid, { text: getTimeoutText(cmsData) });
    }
};

const refreshSessionTimeout = (sock, sessionKey, jid, session, defaultTimeoutSeconds, cmsData) => {
    const timeoutSeconds = Number(session.timeoutSeconds) > 0 ? Number(session.timeoutSeconds) : defaultTimeoutSeconds;

    scheduleSessionTimeout(sessionKey, timeoutSeconds, async () => {
        try {
            await endSession(sock, sessionKey, jid, true, cmsData);
        } catch (error) {
            console.error('[WARGA_TIMEOUT_ERROR]', error);
        }
    });
};

const sendGreetingAndMainMenu = async (sock, msg, cmsData, session) => {
    const jid = msg?.key?.remoteJid;
    if (!jid) return;

    const enabledMainMenu = getEnabledMainMenu(cmsData);
    if (!enabledMainMenu.length) {
        await sock.sendMessage(jid, {
            text: 'Menu layanan belum dikonfigurasi. Silakan hubungi admin.',
        });
        return;
    }

    const greetingText = cmsData.greetingMessage ? `${cmsData.greetingMessage}\n\n` : '';
    const mainText = `${greetingText}Silakan pilih layanan yang Anda butuhkan:`;

    await sendTextMenu(sock, jid, mainText, enabledMainMenu, session);
};

const processWargaInput = async (sock, msg, text, cmsData, session, sessionKey) => {
    const jid = msg?.key?.remoteJid;
    if (!jid) return { endSessionNow: false };

    if (session.awaitingTextFor) {
        const successReply = session.awaitingTextFor.successReply || 'Berhasil. Data Anda sudah kami terima.';
        await sock.sendMessage(jid, { text: successReply });
        session.awaitingTextFor = null;
        session.timeoutSeconds = getTimeoutSeconds(cmsData);
        await wait(2000);
        await sock.sendMessage(jid, { text: getSessionEndText(cmsData) });
        await endSession(sock, sessionKey, jid, false, cmsData);
        return { endSessionNow: true };
    }

    const hasPendingOptions = !!session.currentOptions;

    if (hasPendingOptions && !session.currentOptions[text]) {
        await sock.sendMessage(jid, {
            text: '❌ Pilihan tidak valid. Silakan balas dengan angka yang tersedia pada menu.',
        });
        return { endSessionNow: false };
    }

    const inputId = hasPendingOptions ? session.currentOptions[text] : text;
    const node = resolveMenuNode(cmsData, inputId);

    if (!node) {
        await sock.sendMessage(jid, {
            text: '❌ Pilihan tidak valid. Silakan pilih layanan yang tersedia.',
        });
        return { endSessionNow: false };
    }

    if (node.kind === 'menu') {
        await sendTextMenu(sock, jid, node.text, node.nextMenu, session);
        return { endSessionNow: false };
    }

    session.currentOptions = null;
    await sock.sendMessage(jid, { text: node.text });

    if (node.flowMode === FLOW_MODE.AWAIT_REPLY) {
        session.awaitingTextFor = {
            menuId: inputId,
            successReply: node.successReply,
        };
        session.timeoutSeconds = node.awaitTimeoutSeconds;
        return { endSessionNow: false };
    }

    await wait(2000);
    await sock.sendMessage(jid, { text: getSessionEndText(cmsData) });
    await endSession(sock, sessionKey, jid, false, cmsData);
    return { endSessionNow: true };
};

const handleWargaMessage = async (sock, msg, bodyText = '') => {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    const text = (bodyText || '').trim();
    const normalizedText = text.toLowerCase();
    if (!text) return;

    if (normalizedText === '/setting') {
        await sock.sendMessage(jid, {
            text: 'Akses ditolak. Fitur /setting hanya untuk admin.',
        });
        return;
    }

    const cmsData = await loadCmsData();
    const isAdmin = await isAdminJid(jid, cmsData);
    const timeoutSeconds = getTimeoutSeconds(cmsData);
    if (!isAdmin) {
        await recordWargaChat();
    }

    const sessionContext = await resolveSessionContext(jid);
    let { sessionKey, session } = sessionContext;

    if (!session) {
        session = createSession(sessionKey, timeoutSeconds);
        session.awaitingTextFor = null;
        registerAliasesForJid(sessionKey, jid, session);
        if (!isAdmin) {
            await recordWargaSessionStart();
        }

        await sendGreetingAndMainMenu(sock, msg, cmsData, session);
        refreshSessionTimeout(sock, sessionKey, jid, session, timeoutSeconds, cmsData);
        return;
    }

    registerAliasesForJid(sessionKey, jid, session);

    const result = await processWargaInput(sock, msg, text, cmsData, session, sessionKey);
    if (result?.endSessionNow) return;

    refreshSessionTimeout(sock, sessionKey, jid, session, timeoutSeconds, cmsData);
};

module.exports = {
    handleWargaMessage,
    sessions,
};
