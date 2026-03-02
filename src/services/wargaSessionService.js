const sessions = {};

const clearSessionTimer = (jid) => {
    if (sessions[jid] && sessions[jid].timeoutId) {
        clearTimeout(sessions[jid].timeoutId);
        sessions[jid].timeoutId = null;
    }
};

const startSession = (jid, initialStepId = null, flowMode = 'static', timeoutSeconds = 3600) => {
    clearSessionTimer(jid);
    sessions[jid] = {
        startTime: Date.now(),
        lastInteraction: Date.now(),
        currentStepId: initialStepId,
        flowMode: flowMode,
        answers: {}, // Tempat menyimpan jawaban per stepKey
        timeoutId: null
    };
    refreshSessionTimeout(jid, timeoutSeconds);
    return sessions[jid];
};

const updateSession = (jid, patch = {}) => {
    if (sessions[jid]) {
        sessions[jid] = { ...sessions[jid], ...patch, lastInteraction: Date.now() };
        refreshSessionTimeout(jid, 3600); // Default 1 jam
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
        sessions[jid].timeoutId = setTimeout(() => {
            endSession(jid);
            console.log(`[SESSION_TIMEOUT] Sesi untuk ${jid} telah dihapus otomatis.`);
        }, timeoutSeconds * 1000);
    }
};

module.exports = { sessions, startSession, updateSession, getSession, endSession };
