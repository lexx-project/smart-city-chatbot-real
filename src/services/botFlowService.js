const { nestClient } = require('../api/nestClient');
const { getAdminToken, clearToken } = require('./adminAuthService');

// ── HELPER: Request dengan Auto-Retry jika 401 ──
const requestWithRetry = async (method, url, data = null, params = {}) => {
    let token = await getAdminToken();
    if (!token) return null;

    const execute = async (authToken) => {
        const config = { headers: { Authorization: `Bearer ${authToken}` }, params };
        if (method.toLowerCase() === 'get') return await nestClient.get(url, config);
        if (method.toLowerCase() === 'post') return await nestClient.post(url, data, config);
        if (method.toLowerCase() === 'patch') return await nestClient.patch(url, data, config);
    };

    try {
        const res = await execute(token);
        return res.data;
    } catch (error) {
        if (error?.response?.status === 401) {
            console.log(`[AUTH] 401 Unauthorized di ${url}. Merefresh token...`);
            clearToken();
            const newToken = await getAdminToken();
            if (newToken) {
                try {
                    const retryRes = await execute(newToken);
                    return retryRes.data;
                } catch (retryErr) {
                    console.error(`[AUTH] Retry tetap gagal:`, retryErr.message);
                }
            }
        }
        // Log 404 agar tidak membingungkan
        if (error?.response?.status === 404) {
            console.warn(`[API_404] Endpoint tidak ditemukan: ${url}`);
        } else {
            console.error(`[API_ERROR] ${method.toUpperCase()} ${url}:`, error.message);
        }
        return null;
    }
};

const getBotSettings = async () => {
    const res = await requestWithRetry('GET', '/cms/bot-flow/messages', null, { limit: 100 });
    const messages = res?.data || [];
    const greetingMsg = messages.find(m => m.messageKey === 'GREETING_MSG' || m.messageKey === 'greeting');
    const endMsg = messages.find(m => m.messageKey === 'SESSION_END_TEXT' || m.messageKey === 'end_session');

    return {
        GREETING_MSG: greetingMsg ? greetingMsg.messageText : 'Halo! 👋',
        SESSION_END_TEXT: endMsg ? endMsg.messageText : 'Terima kasih.'
    };
};

const getMainMenu = async () => {
    const res = await requestWithRetry('GET', '/cms/bot-flow/flows', null, { limit: 100 });
    const flows = res?.data || [];
    if (flows.length === 0) return null;

    return {
        id: 'root_menu',
        stepKey: 'main_menu',
        messages: [],
        children: flows.map((flow, index) => {
            const firstStep = flow.steps?.find(s => s.stepOrder === 1) || flow.steps?.[0];
            return {
                id: firstStep ? firstStep.id : flow.id,
                stepOrder: index + 1,
                stepKey: flow.flowName
            };
        })
    };
};

const getStep = async (stepIdOrKey) => {
    if (stepIdOrKey === 'root_menu') return await getMainMenu();

    // FETCH LIST (Karena endpoint detail /steps/{id} tidak ada)
    const res = await requestWithRetry('GET', '/cms/bot-flow/steps', null, { limit: 100 });
    const steps = res?.data || [];
    return steps.find(s => s.id === stepIdOrKey || s.stepKey === stepIdOrKey) || null;
};

const submitTicket = async (payload) => requestWithRetry('POST', '/tickets', payload);

const getOrCreateUser = async (phone, name) => {
    const search = await requestWithRetry('GET', '/users', null, { phone });
    const list = search?.data || search;
    if (Array.isArray(list) && list.length > 0) return list[0].id;

    const create = await requestWithRetry('POST', '/users', { phoneNumber: String(phone), name });
    return create?.data?.id || create?.id || null;
};

const getCategoryIdFromFlow = async (flowId) => {
    if (!flowId) return null;
    const res = await requestWithRetry('GET', `/cms/bot-flow/flows/${flowId}`);
    const data = res?.data || res;
    return data?.categoryId || data?.category?.id || null;
};

const getCmsMessages = async () => {
    const res = await requestWithRetry('GET', '/cms/bot-flow/messages', null, { limit: 100 });
    return res?.data || res;
};

const updateCmsMessage = async (id, payload) => requestWithRetry('PATCH', `/cms/bot-flow/messages/${id}`, payload);
const createCmsFlow = async (payload) => requestWithRetry('POST', '/cms/bot-flow/flows', payload);
const createCmsStep = async (payload) => requestWithRetry('POST', '/cms/bot-flow/steps', payload);

module.exports = { getMainMenu, getStep, getBotSettings, submitTicket, getCategoryIdFromFlow, getOrCreateUser, getCmsMessages, updateCmsMessage, createCmsFlow, createCmsStep };
