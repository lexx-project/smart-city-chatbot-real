const nestClient = require('../api/nestClient');

const getMainMenu = async () => {
    try {
        const response = await nestClient.get('/bot-flow/menu');
        return response.data;
    } catch (error) {
        console.error('[BOT_FLOW_ERROR] Gagal mengambil menu utama:', error?.message);
        return null;
    }
};

const getStepById = async (stepId) => {
    try {
        const response = await nestClient.get(`/bot-flow/step/${stepId}`);
        return response.data;
    } catch (error) {
        console.error(`[BOT_FLOW_ERROR] Gagal mengambil step ${stepId}:`, error?.message);
        return null;
    }
};

module.exports = {
    getMainMenu,
    getStepById,
};
