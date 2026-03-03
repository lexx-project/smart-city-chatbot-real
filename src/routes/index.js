const { handleAdminMessage } = require('../controllers/adminController');
const { handleWargaMessage } = require('../controllers/wargaController');
const { logIncomingChat } = require('../utils/logger');
const { extractBodyText, shouldSkipMessage, isStaleMessage } = require('../middlewares/messageMiddleware');

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
                if (processedMessageIds.has(msgId)) {
                    // Pesan ini sudah pernah diproses, skip sepenuhnya
                    continue;
                }
                processedMessageIds.add(msgId);
                // Auto-cleanup setelah 10 detik untuk hemat memori
                setTimeout(() => processedMessageIds.delete(msgId), 10_000);
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

                handledByAdmin = await handleAdminMessage(sock, msg, bodyText);
                if (handledByAdmin) continue;

                if (!bodyText) continue;
                logIncomingChat(msg, 'WARGA');

                await handleWargaMessage(sock, msg, bodyText);
            } catch (error) {
                console.error('[ROUTER_MESSAGE_ERROR]', error);
                // Jika error terjadi di flow admin, JANGAN kirim pesan "gangguan" ke admin
                if (handledByAdmin) continue;
            }
        }
    });
};

module.exports = {
    registerRoutes,
};
