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

                // ═══════════════════════════════════════════
                //  STEP 1: CEK SESSION DULU (SYNCHRONOUS!)
                //  getAdminSession() baca dari memory, INSTANT.
                //  Tidak bergantung pada API yang bisa gagal.
                // ═══════════════════════════════════════════
                const adminSession = getAdminSession(jid);
                if (adminSession) {
                    // Ada sesi admin aktif → langsung ke adminController, STOP.
                    await handleAdminMessage(sock, msg, bodyText);
                    continue;
                }

                // ═══════════════════════════════════════════
                //  STEP 2: CEK ADMIN (ASYNC) — hanya jika
                //  tidak ada session aktif
                // ═══════════════════════════════════════════
                const pushName = msg.pushName || '';
                const isAdmin = await isAdminJid(sock, jid, pushName);

                if (isAdmin) {
                    // Admin tanpa sesi → coba handle command (/buildmenu dll)
                    await handleAdminMessage(sock, msg, bodyText);
                    continue; // Admin TIDAK PERNAH ke wargaController
                } else {
                    // Bukan admin → wargaController
                    if (!bodyText) continue;
                    logIncomingChat(msg, 'WARGA');
                    await handleWargaMessage(sock, msg, bodyText);
                }

            } catch (error) {
                console.error('[ROUTER_MESSAGE_ERROR]', error);
            }
        }
    });
};

module.exports = {
    registerRoutes,
};
