const { handleAdminMessage } = require('../controllers/adminController');
const { handleWargaMessage } = require('../controllers/wargaController');
const { logIncomingChat } = require('../utils/logger');
const { extractBodyText, shouldSkipMessage, isStaleMessage } = require('../middlewares/messageMiddleware');

const registerRoutes = (sock) => {
    sock.ev.on('messages.upsert', async ({ type, messages }) => {
        if (type !== 'notify') return;
        if (!Array.isArray(messages) || messages.length === 0) return;

        for (const msg of messages) {
            try {
                if (shouldSkipMessage(msg)) continue;

                const jid = msg.key.remoteJid;
                if (!jid) continue;

                if (isStaleMessage(msg, 60)) {
                    console.log(`[ANTI-SPAM] Membuang pesan basi dari: ${jid}`);
                    continue;
                }

                const bodyText = extractBodyText(msg);
                msg.bodyText = bodyText;

                const handledByAdmin = await handleAdminMessage(sock, msg, bodyText);
                if (handledByAdmin) continue;

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
