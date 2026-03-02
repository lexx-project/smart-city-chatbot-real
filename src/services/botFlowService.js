const nestClient = require('../api/nestClient');

const getMainMenu = async () => {
    try {
        const response = await nestClient.get('/bot-flow/menu');
        return response.data;
    } catch (error) {
        return null;
    }
};

const getStepById = async (stepId) => {
    try {
        const response = await nestClient.get(`/bot-flow/step/${stepId}`);
        return response.data;
    } catch (error) {
        return null;
    }
};

const submitTicket = async (payload) => {
    try {
        // Tembak ke endpoint tiket (sesuaikan dengan controller tiket di BE)
        const response = await nestClient.post('/tickets', payload);
        return response.data;
    } catch (error) {
        console.error('[TICKET_SUBMIT_ERROR]', error?.response?.data || error.message);
        return null;
    }
};

module.exports = { getMainMenu, getStepById, submitTicket };
