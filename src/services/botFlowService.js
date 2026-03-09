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
        if (method.toLowerCase() === 'delete') return await nestClient.delete(url, config);
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
        // Log Error Spesifik biar lu gampang debug
        if (error?.response?.status === 400) {
            console.error(`[API_400] Validation Failed di ${url}:`, error.response?.data);
        } else if (error?.response?.status === 404) {
            console.warn(`[API_404] Endpoint tidak ditemukan: ${url}`);
        } else {
            console.error(`[API_ERROR] ${method.toUpperCase()} ${url}:`, error.message);
        }
        return null;
    }
};

let cachedFlows = [];

const syncFlowsCache = async () => {
    try {
        console.log("[CACHE] 🔄 Memulai sinkronisasi data Flow dari CMS...");
        let page = 1;
        let hasNextPage = true;
        let allFlows = [];

        while (hasNextPage) {
            const res = await requestWithRetry('GET', '/cms/bot-flow/flows', null, { limit: 100, page: page });
            const list = res?.data || [];

            if (Array.isArray(list)) {
                allFlows = allFlows.concat(list);
            }

            hasNextPage = res?.meta?.hasNextPage || false;
            page++;
        }

        if (allFlows.length > 0) {
            cachedFlows = allFlows;
            console.log(`[CACHE] ✅ Sinkronisasi sukses! ${cachedFlows.length} Flows tersimpan di memori.`);
        }
    } catch (error) {
        console.error("[CACHE] ❌ Sinkronisasi gagal:", error?.message || error);
    }
};

syncFlowsCache(); // Tarikan pertama saat booting
setInterval(syncFlowsCache, 5 * 60 * 1000); // Polling setiap 5 menit

// ── USER SYNC (Target PM: Data Contact) ──

const getOrCreateUser = async (phone, name) => {
    // Cari user berdasarkan nomor HP (BE menggunakan query param 'search')
    const search = await requestWithRetry('GET', '/users', null, { search: phone });
    const list = search?.data || search;

    // Jika user sudah ada, kembalikan ID-nya
    if (Array.isArray(list) && list.length > 0) return list[0].id;

    // Jika belum ada, buat warga baru menggunakan 'fullName' sesuai schema BE
    const create = await requestWithRetry('POST', '/users', {
        phoneNumber: String(phone),
        fullName: name
    });

    return create?.data?.id || create?.id || null;
};

// ── SESSION MANAGEMENT (Target PM: History Tgl/Jam) ──

const createRemoteSession = async (phoneNumber) => {
    // Membuat sesi baru di BE untuk mencatat 'startedAt'
    const res = await requestWithRetry('POST', '/conversation/sessions', {
        phoneNumber: String(phoneNumber),
        provider: 'whatsapp'
    });
    return res?.session?.id || res?.data?.session?.id || null;
};

const updateRemoteSessionState = async (sessionId, state = 'IN_FLOW') => {
    // Update state sesi (IDLE, COLLECTING_CATEGORY, dll)
    return await requestWithRetry('PATCH', `/conversation/sessions/${sessionId}/state`, { state });
};

const endRemoteSession = async (sessionId) => {
    // Menutup sesi secara paksa di Backend
    return await requestWithRetry('PATCH', `/conversation/sessions/${sessionId}/end`, {});
};

// ── WEBHOOK LOGGING (Target PM: History Kategori & Chat) ──

/**
 * FIXED: Menerima 'phone' langsung dari controller. 
 * Tidak lagi membelah JID di sini biar nggak kena LID issue.
 */
const logMessageToBackend = async (phone, content) => {
    const payload = {
        entry: [{
            changes: [{
                value: {
                    messages: [{
                        from: String(phone), // Pastikan nomor HP asli
                        text: { body: String(content) } // Isi pesan
                    }]
                }
            }]
        }]
    };
    // Melaporkan ke Webhook BE untuk mencatat riwayat pesan & Total Chat
    return await requestWithRetry('POST', '/conversation/webhook', payload);
};

// ── BOT CONFIGURATION & FLOW ──

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
    const res = await requestWithRetry('GET', '/cms/bot-flow/flows', null, { limit: 50 });
    const flows = res?.data || [];
    if (flows.length === 0) return null;

    return {
        id: 'root_menu',
        stepKey: 'main_menu',
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

    let foundStep = null;

    for (const flow of cachedFlows) {
        if (flow.steps && Array.isArray(flow.steps)) {
            foundStep = flow.steps.find(s => s.id === stepIdOrKey || s.stepKey === stepIdOrKey);
            if (foundStep) break;
        }
    }

    if (!foundStep) {
        const targetFlow = cachedFlows.find(f => f.id === stepIdOrKey);
        if (targetFlow && targetFlow.steps && Array.isArray(targetFlow.steps)) {
            foundStep = targetFlow.steps.find(s => s.stepOrder === 1) || targetFlow.steps[0];
        }
    }

    return foundStep || null;
};

const submitTicket = async (payload) => requestWithRetry('POST', '/tickets', payload);

const getCategoryIdFromFlow = async (flowId) => {
    if (!flowId) return null;
    const res = await requestWithRetry('GET', `/cms/bot-flow/flows/${flowId}`);
    const data = res?.data || res;
    return data?.categoryId || data?.category?.id || null;
};

// ── CMS MANAGEMENT (Admin Features) ──

const getCmsMessages = () => requestWithRetry('GET', '/cms/bot-flow/messages', null, { limit: 100 });
const updateCmsMessage = (id, payload) => requestWithRetry('PATCH', `/cms/bot-flow/messages/${id}`, payload);
const createCmsFlow = (payload) => requestWithRetry('POST', '/cms/bot-flow/flows', payload);
const createCmsStep = (payload) => requestWithRetry('POST', '/cms/bot-flow/steps', payload);

const getStaffData = async (phone) => {
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
        const res = await requestWithRetry('GET', '/staff', null, { limit: 100, page: page });
        const list = res?.data || res;

        if (Array.isArray(list) && list.length > 0) {
            const user = list.find(u => String(u.phone) === String(phone));

            if (user) {
                let roleName = '';
                if (typeof user.role === 'string') {
                    roleName = user.role;
                } else if (typeof user.role === 'object' && user.role !== null) {
                    roleName = user.role.name || '';
                }

                if (['ADMIN', 'SUPER_ADMIN', 'STAFF'].includes(roleName.toUpperCase())) {
                    user.roleNameString = roleName.toUpperCase();
                    return user; // KETEMU! (hentikan loop)
                }
            }
        }

        hasNextPage = res?.meta?.hasNextPage || false;
        page++;
    }

    return null;
};

module.exports = {
    getMainMenu,
    getStep,
    getBotSettings,
    submitTicket,
    getCategoryIdFromFlow,
    getOrCreateUser,
    getCmsMessages,
    updateCmsMessage,
    createCmsFlow,
    createCmsStep,
    createRemoteSession,
    updateRemoteSessionState,
    logMessageToBackend,
    endRemoteSession,
    getStaffData
};