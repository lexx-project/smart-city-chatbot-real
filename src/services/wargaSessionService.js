const { toSessionKey } = require('./lidService');

const sessions = new Map();
const sessionAliasIndex = new Map();

const clearSessionTimer = (sessionKey) => {
    const session = sessions.get(sessionKey);
    if (!session?.timeoutId) return;
    clearTimeout(session.timeoutId);
};

const registerSessionAlias = (sessionKey, alias, session) => {
    if (!alias) return;
    sessionAliasIndex.set(alias, sessionKey);
    if (!session._aliases) session._aliases = new Set();
    session._aliases.add(alias);
};

const registerAliasesForJid = (sessionKey, jid, session) => {
    const local = String(jid || '').split('@')[0] || '';
    registerSessionAlias(sessionKey, jid, session);
    registerSessionAlias(sessionKey, local, session);
};

const resolveSessionContext = async (jid) => {
    const rawSessionKey = await toSessionKey(jid);
    let sessionKey = rawSessionKey;
    let session = sessions.get(sessionKey);

    if (!session) {
        const local = String(jid).split('@')[0] || '';
        const aliasedKey = sessionAliasIndex.get(jid) || sessionAliasIndex.get(local);
        if (aliasedKey && sessions.has(aliasedKey)) {
            sessionKey = aliasedKey;
            session = sessions.get(aliasedKey);
        }
    }

    return { sessionKey, session };
};

const createSession = (sessionKey, timeoutSeconds) => {
    const session = {
        startedAt: Date.now(),
        timeoutSeconds,
        timeoutId: null,
        currentOptions: null,
        _aliases: new Set(),
    };
    sessions.set(sessionKey, session);
    return session;
};

const deleteSession = (sessionKey) => {
    const session = sessions.get(sessionKey);
    clearSessionTimer(sessionKey);
    sessions.delete(sessionKey);

    if (session?._aliases) {
        for (const alias of session._aliases) {
            if (sessionAliasIndex.get(alias) === sessionKey) {
                sessionAliasIndex.delete(alias);
            }
        }
    }
};

const scheduleSessionTimeout = (sessionKey, timeoutSeconds, onTimeout) => {
    clearSessionTimer(sessionKey);

    const timeoutId = setTimeout(async () => {
        await onTimeout();
    }, timeoutSeconds * 1000);

    const current = sessions.get(sessionKey) || {};
    current.timeoutId = timeoutId;
    current.timeoutSeconds = timeoutSeconds;
    current.updatedAt = Date.now();
    sessions.set(sessionKey, current);
};

module.exports = {
    sessions,
    clearSessionTimer,
    registerAliasesForJid,
    resolveSessionContext,
    createSession,
    deleteSession,
    scheduleSessionTimeout,
};
