const sessions = {};

const getSession = (jid) => sessions[jid] || null;

const startSession = (jid, initialStepId = null, flowMode = 'static') => {
    sessions[jid] = {
        startTime: Date.now(),
        lastInteraction: Date.now(),
        currentStepId: initialStepId,
        flowMode,
    };
    return sessions[jid];
};

const updateSession = (jid, patch = {}) => {
    if (!sessions[jid]) return null;

    sessions[jid] = {
        ...sessions[jid],
        ...patch,
        lastInteraction: Date.now(),
    };

    return sessions[jid];
};

const endSession = (jid) => {
    delete sessions[jid];
};

module.exports = {
    sessions,
    getSession,
    startSession,
    updateSession,
    endSession,
};
