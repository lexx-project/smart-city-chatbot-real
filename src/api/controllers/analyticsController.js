const { sessions } = require('../../controllers/wargaController');
const { countWargaChatsInLastDays, countWargaSessionsInLastDays } = require('../../services/analyticsService');

const RANGE_TO_DAYS = {
    '1d': 1,
    '7d': 7,
    '30d': 30,
    '1y': 365,
};

const getRealtimeAnalytics = async (req, res) => {
    try {
        return res.status(200).json({ success: true, data: { activeSessions: sessions.size } });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal membaca analytics realtime.', error: error.message });
    }
};

const getAnalyticsSummary = async (req, res) => {
    try {
        const range = String(req.query.range || '7d').toLowerCase();
        const days = RANGE_TO_DAYS[range];
        if (!days) return res.status(400).json({ success: false, message: 'range tidak valid. Gunakan: 1d, 7d, 30d, 1y.' });

        const [totalWargaChats, totalWargaSessions] = await Promise.all([
            countWargaChatsInLastDays(days),
            countWargaSessionsInLastDays(days),
        ]);

        return res.status(200).json({
            success: true,
            data: {
                range,
                days,
                totalWargaChats,
                totalWargaSessions,
                activeSessions: sessions.size,
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal membaca analytics summary.', error: error.message });
    }
};

module.exports = {
    getRealtimeAnalytics,
    getAnalyticsSummary,
};
