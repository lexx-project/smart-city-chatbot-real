const nestClient = require('../api/nestClient');
const { getAdminToken, clearToken } = require('./adminAuthService');

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

const getCmsMessages = async () => {
    const token = await getAdminToken();
    if (!token) return null;

    try {
        const response = await nestClient.get('/cms/bot-flow/messages', {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data?.data || response.data;
    } catch (error) {
        if (error?.response?.status === 401) clearToken(); // Reset token jika expired
        console.error('[CMS_GET_MSG_ERROR]', error?.response?.data || error.message);
        return null;
    }
};

const updateCmsMessage = async (id, payload) => {
    const token = await getAdminToken();
    if (!token) return null;

    try {
        const response = await nestClient.patch(`/cms/bot-flow/messages/${id}`, payload, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data?.data || response.data;
    } catch (error) {
        if (error?.response?.status === 401) clearToken(); // Reset token jika expired
        console.error('[CMS_PATCH_MSG_ERROR]', error?.response?.data || error.message);
        return null;
    }
};

module.exports = { getMainMenu, getStepById, submitTicket, getCmsMessages, updateCmsMessage };
