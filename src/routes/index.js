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

            let handledByAdmin = false;

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

                // ── ADMIN FLOW ──
                handledByAdmin = await handleAdminMessage(sock, msg, bodyText);
                if (handledByAdmin) continue;

                // ── ADMIN SESSION GUARD ──
                // Jika admin punya sesi aktif, JANGAN teruskan ke wargaController
                const adminSession = getAdminSession(jid);
                if (adminSession) {
                    console.log(`[ROUTER] Admin ${jid} punya sesi aktif (step: ${adminSession.step}), skip wargaController`);
                    continue;
                }

                if (!bodyText) continue;
                logIncomingChat(msg, 'WARGA');

                await handleWargaMessage(sock, msg, bodyText);
            } catch (error) {
                console.error('[ROUTER_MESSAGE_ERROR]', error);
                // Jika error terjadi di flow admin, JANGAN trigger apapun
                if (handledByAdmin) continue;
            }
        }
    });
};

module.exports = {
    registerRoutes,
};
