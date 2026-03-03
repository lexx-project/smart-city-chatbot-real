const { handleAdminMessage } = require('../controllers/adminController');
const { handleWargaMessage } = require('../controllers/wargaController');
const { logIncomingChat } = require('../utils/logger');
const { extractBodyText, shouldSkipMessage, isStaleMessage } = require('../middlewares/messageMiddleware');
const { isAdminJid } = require('../services/adminService');
const { getAdminSession } = require('../services/adminSessionService');

// ═══════════════════════════════════════════════════════
//  GLOBAL MESSAGE LOCKING — Mencegah double-processing
//  dari Baileys race condition / duplicate event trigger
// ═══════════════════════════════════════════════════════
const processedMessageIds = new Set();

const registerRoutes = (sock) => {
    sock.ev.on('messages.upsert', async ({ type, messages }) => {
        if (type !== 'notify') return;
        if (!Array.isArray(messages) || messages.length === 0) return;

        for (const msg of messages) {
            // ── GLOBAL DEDUP: Cek & lock message ID ──
            const msgId = msg?.key?.id;
            if (msgId) {
                if (processedMessageIds.has(msgId)) continue;
                processedMessageIds.add(msgId);
                setTimeout(() => processedMessageIds.delete(msgId), 5_000);
            }

            try {
                if (shouldSkipMessage(msg)) continue;

                const jid = msg.key.remoteJid;
                if (!jid) continue;

                if (isStaleMessage(msg, 120)) {
                    console.log(`[ANTI-SPAM] Membuang pesan basi dari: ${jid}`);
                    continue;
                }

                const bodyText = extractBodyText(msg);
                msg.bodyText = bodyText;
                const pushName = msg.pushName || '';

                // ═══════════════════════════════════════════
                //  TOTAL SESSION ISOLATION
                //  Resolve isAdmin di level router SEBELUM
                //  memanggil controller manapun
                // ═══════════════════════════════════════════
                const isAdmin = await isAdminJid(sock, jid, pushName);
                const adminSession = getAdminSession(jid);

                // CASE 1: Admin dengan sesi aktif → HANYA adminController, STOP.
                if (isAdmin && adminSession) {
                    await handleAdminMessage(sock, msg, bodyText);
                    continue; // JANGAN pernah ke wargaController
                }

                // CASE 2: Admin tanpa sesi aktif → coba adminController dulu
                if (isAdmin) {
                    const handledByAdmin = await handleAdminMessage(sock, msg, bodyText);
                    if (handledByAdmin) continue;
                    // Admin tanpa sesi & bukan command → skip wargaController juga
                    continue;
                }

                // CASE 3: Bukan admin → wargaController
                if (!bodyText) continue;
                logIncomingChat(msg, 'WARGA');
                await handleWargaMessage(sock, msg, bodyText);

            } catch (error) {
                console.error('[ROUTER_MESSAGE_ERROR]', error);
            }
        }
    });
};

module.exports = {
    registerRoutes,
};
