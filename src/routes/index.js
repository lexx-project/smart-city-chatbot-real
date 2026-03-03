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
    sock.ev.on('messages.upsert', async (m) => {
        // STEP A: Immediate Dedup & Validation
        if (m.type !== 'notify') return;
        if (!Array.isArray(m.messages) || m.messages.length === 0) return;

        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const msgId = msg.key.id;
            const jid = msg.key.remoteJid;
            if (!jid || !msgId) continue;

            // Global Dedup (5s window)
            if (processedMessageIds.has(msgId)) continue;
            processedMessageIds.add(msgId);
            setTimeout(() => processedMessageIds.delete(msgId), 5_000);

            if (isStaleMessage(msg, 120)) {
                console.log(`[ANTI-SPAM] Membuang pesan basi dari: ${jid}`);
                continue;
            }

            try {
                const bodyText = extractBodyText(msg);
                msg.bodyText = bodyText;
                const pushName = msg.pushName || '';

                // ═══════════════════════════════════════════
                //  MASTER GATEKEEPER: Prioritized Waterfall
                // ═══════════════════════════════════════════
                console.log(`[GATEKEEPER][PID:${process.pid}] Incoming: "${bodyText}" from ${jid}`);

                // STEP B: Synchronous Admin Session Check (Instant/Memory)
                const session = getAdminSession(jid);
                if (session) {
                    console.log(`[GATEKEEPER][PID:${process.pid}] P1 HIT: Admin Session Aktif (${jid})`);
                    await handleAdminMessage(sock, msg, bodyText);
                    return; // PRIORITAS 1: Stop here.
                }

                // STEP C: Async Admin Identity Check
                const isAdmin = await isAdminJid(sock, jid, pushName);
                if (isAdmin) {
                    // Hanya proses jika ini adalah perintah admin (diawali /)
                    if (bodyText.startsWith('/')) {
                        console.log(`[GATEKEEPER][PID:${process.pid}] P2 HIT: Admin Command (${jid})`);
                        await handleAdminMessage(sock, msg, bodyText);
                        return; // PRIORITAS 2: Stop here.
                    }

                    // Jika admin ketik biasa (bukan command), abaikan / jangan lempar ke warga flow
                    console.log(`[GATEKEEPER][PID:${process.pid}] P2 HIT: Admin Chat Biasa -> IGNORE (${jid})`);
                    return;
                }

                // STEP D: Warga Catch-all
                // Hanya reached jika bukan admin session dan bukan admin command
                if (!bodyText) continue;
                console.log(`[GATEKEEPER][PID:${process.pid}] P3 HIT: Warga Flow (${jid})`);
                logIncomingChat(msg, 'WARGA');
                await handleWargaMessage(sock, msg, bodyText);

            } catch (error) {
                console.error(`[MASTER_GATEKEEPER_ERROR][PID:${process.pid}]`, error);
            }
        }
    });
};

module.exports = {
    registerRoutes,
};
