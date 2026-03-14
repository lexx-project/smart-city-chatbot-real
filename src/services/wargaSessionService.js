const { getAdminTimeout, getAdminTimeoutText } = require('./adminSettingsService');

const sessions = {};

const clearSessionTimer = (jid) => {
    if (sessions[jid] && sessions[jid].timeoutId) {
        clearTimeout(sessions[jid].timeoutId);
        sessions[jid].timeoutId = null;
    }
};

const startSession = (jid, sock, initialStepId = null, flowMode = 'static', timeoutSeconds = null) => {
    clearSessionTimer(jid);
    sessions[jid] = {
        startTime: Date.now(),
        lastInteraction: Date.now(),
        currentStepId: initialStepId,
        stepHistory: [], // Menambahkan array untuk mengingat riwayat menu
        flowMode: flowMode,
        answers: {}, // Tempat menyimpan jawaban per stepKey
        timeoutId: null,
        sock: sock // Simpan instance sock
    };
    refreshSessionTimeout(jid, timeoutSeconds || getAdminTimeout());
    return sessions[jid];
};

const updateSession = (jid, patch = {}, timeoutSeconds = null) => {
    if (sessions[jid]) {
        sessions[jid] = { ...sessions[jid], ...patch, lastInteraction: Date.now() };
        refreshSessionTimeout(jid, timeoutSeconds || getAdminTimeout());
    }
    return sessions[jid];
};

const getSession = (jid) => sessions[jid] || null;

const endSession = (jid) => {
    clearSessionTimer(jid);
    if (sessions[jid]) delete sessions[jid];
};

const refreshSessionTimeout = (jid, timeoutSeconds) => {
    clearSessionTimer(jid);
    if (sessions[jid]) {
        const sock = sessions[jid].sock; // Ambil socket yang tersimpan
        sessions[jid].timeoutId = setTimeout(async () => {
            endSession(jid);
            console.log(`[SESSION_TIMEOUT] Sesi untuk ${jid} telah dihapus otomatis.`);
            if (sock) {
                try {
                    const timeoutMsg = getAdminTimeoutText();
                    await sock.sendMessage(jid, { text: timeoutMsg });
                } catch (e) {
                    console.error('[WARGA_SESSION_TIMEOUT_ERROR] Failed to send message:', e);
                }
            }
        }, timeoutSeconds * 1000);
    }
};

module.exports = { sessions, startSession, updateSession, getSession, endSession };
