const fs = require('fs/promises');
const path = require('path');

const ANALYTICS_PATH = path.join(__dirname, '../config/analytics-data.json');
const MAX_RETENTION_DAYS = 370;

const DEFAULT_DATA = {
    chatTimestamps: [],
    sessionTimestamps: [],
};

const ensureDataShape = (raw = {}) => ({
    chatTimestamps: Array.isArray(raw.chatTimestamps) ? raw.chatTimestamps.filter((v) => Number.isFinite(Number(v))) : [],
    sessionTimestamps: Array.isArray(raw.sessionTimestamps) ? raw.sessionTimestamps.filter((v) => Number.isFinite(Number(v))) : [],
});

const loadAnalyticsData = async () => {
    try {
        const raw = await fs.readFile(ANALYTICS_PATH, 'utf-8');
        return ensureDataShape(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_DATA };
    }
};

const saveAnalyticsData = async (data) => {
    await fs.writeFile(ANALYTICS_PATH, JSON.stringify(data, null, 2), 'utf-8');
};

const cutoffFromDays = (days, now = Date.now()) => now - (Number(days) * 24 * 60 * 60 * 1000);

const pruneOld = (data, now = Date.now()) => {
    const cutoff = cutoffFromDays(MAX_RETENTION_DAYS, now);
    data.chatTimestamps = data.chatTimestamps.filter((ts) => Number(ts) >= cutoff);
    data.sessionTimestamps = data.sessionTimestamps.filter((ts) => Number(ts) >= cutoff);
    return data;
};

const recordWargaChat = async (at = Date.now()) => {
    const data = pruneOld(await loadAnalyticsData(), at);
    data.chatTimestamps.push(Number(at));
    await saveAnalyticsData(data);
};

const recordWargaSessionStart = async (at = Date.now()) => {
    const data = pruneOld(await loadAnalyticsData(), at);
    data.sessionTimestamps.push(Number(at));
    await saveAnalyticsData(data);
};

const countByRange = async (key, days, now = Date.now()) => {
    const data = pruneOld(await loadAnalyticsData(), now);
    const cutoff = cutoffFromDays(days, now);
    const arr = key === 'session' ? data.sessionTimestamps : data.chatTimestamps;
    return arr.filter((ts) => Number(ts) >= cutoff).length;
};

const countWargaChatsInLastDays = async (days) => countByRange('chat', days);
const countWargaSessionsInLastDays = async (days) => countByRange('session', days);

module.exports = {
    recordWargaChat,
    recordWargaSessionStart,
    countWargaChatsInLastDays,
    countWargaSessionsInLastDays,
};
