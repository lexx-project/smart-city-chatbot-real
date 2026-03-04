const { nestClient } = require('../api/nestClient');

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
    const token = await getAdminToken();
    if (!token) {
        console.error('[TICKET_SUBMIT_ERROR] Gagal mendapatkan token admin. Tiket tidak bisa dikirim.');
        return null;
    }

    try {
        const response = await nestClient.post('/tickets', payload, {
            headers: { Authorization: `Bearer ${token}` },
        });
        return response.data;
    } catch (error) {
        if (error?.response?.status === 401) clearToken(); // Reset token jika expired
        console.error('[TICKET_SUBMIT_ERROR]', error?.response?.data || error.message);
        return null;
    }
};

/**
 * Cari user berdasarkan nomor HP. Jika belum ada, buat baru.
 * Mengembalikan userId (UUID) atau null jika gagal.
 * @param {string} phone - Nomor HP dalam format digit (e.g. '6281234567890')
 * @param {string} name  - Nama warga (dari pushName WhatsApp)
 * @returns {Promise<string|null>}
 */
const getOrCreateUser = async (phone, name) => {
    const token = await getAdminToken();
    if (!token) {
        console.error('[USER_RESOLVER] Gagal mendapatkan token admin.');
        return null;
    }
    const headers = { Authorization: `Bearer ${token}` };

    // 1. Coba cari user berdasarkan nomor HP
    try {
        const res = await nestClient.get('/users', { params: { phone }, headers });
        const list = res.data?.data || res.data;
        if (Array.isArray(list) && list.length > 0) {
            const userId = list[0].id;
            console.log(`[USER_RESOLVER] User ditemukan: ${userId}`);
            return userId;
        }
    } catch (err) {
        if (err?.response?.status === 401) clearToken();
        // Jika 404 atau kosong, lanjut ke pembuatan user baru
        if (err?.response?.status !== 404) {
            console.error('[USER_RESOLVER] Error saat mencari user:', err?.response?.data || err.message);
        }
    }

    // 2. User belum ada — buat baru
    try {
        const res = await nestClient.post('/users', { phoneNumber: String(phone), name }, { headers });
        const userId = res.data?.data?.id || res.data?.id;
        console.log(`[USER_RESOLVER] User baru dibuat: ${userId}`);
        return userId || null;
    } catch (err) {
        if (err?.response?.status === 401) clearToken();
        console.error('[USER_RESOLVER] Error saat membuat user:', err?.response?.data || err.message);
        return null;
    }
};

/**
 * Ambil categoryId (UUID) dari data BotFlow berdasarkan flowId.
 * @param {string} flowId - UUID dari BotFlow
 * @returns {Promise<string|null>}
 */
const getCategoryIdFromFlow = async (flowId) => {
    if (!flowId) return null;
    const token = await getAdminToken();
    if (!token) {
        console.error('[CATEGORY_RESOLVER] Gagal mendapatkan token admin.');
        return null;
    }

    try {
        const res = await nestClient.get(`/cms/bot-flow/flows/${flowId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const data = res.data?.data || res.data;
        const categoryId = data?.categoryId || data?.category?.id || null;
        console.log(`[CATEGORY_RESOLVER] flowId=${flowId} → categoryId=${categoryId}`);
        return categoryId;
    } catch (err) {
        if (err?.response?.status === 401) clearToken();
        console.error('[CATEGORY_RESOLVER] Error:', err?.response?.data || err.message);
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

const createCmsFlow = async (payload) => {
    const token = await getAdminToken();
    if (!token) return null;

    try {
        const response = await nestClient.post('/cms/bot-flow/flows', payload, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data?.data || response.data;
    } catch (error) {
        if (error?.response?.status === 401) clearToken();
        console.error('[CMS_CREATE_FLOW_ERROR]', error?.response?.data || error.message);
        return null;
    }
};

const createCmsStep = async (payload) => {
    const token = await getAdminToken();
    if (!token) return null;

    try {
        const response = await nestClient.post('/cms/bot-flow/steps', payload, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.data?.data || response.data;
    } catch (error) {
        if (error?.response?.status === 401) clearToken();
        console.error('[CMS_CREATE_STEP_ERROR]', error?.response?.data || error.message);
        return null;
    }
};

module.exports = { getMainMenu, getStepById, submitTicket, getCategoryIdFromFlow, getOrCreateUser, getCmsMessages, updateCmsMessage, createCmsFlow, createCmsStep };
