const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { downloadMediaMessage, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { unwrapMessage } = require('../middlewares/messageMiddleware');

const resolveBotJid = (sock) => {
    const raw = String(sock?.user?.id || '').trim();
    if (!raw) return '';
    return jidNormalizedUser(raw);
};

const updateBotProfilePictureFromMessage = async (sock, msg) => {
    const botJid = resolveBotJid(sock);
    if (!botJid) throw new Error('BOT_JID_NOT_FOUND');

    const unwrapped = unwrapMessage(msg?.message || {});
    const imageMessage = unwrapped?.imageMessage;
    if (!imageMessage) throw new Error('IMAGE_MESSAGE_NOT_FOUND');

    const normalizedMsg = {
        key: msg.key,
        message: { imageMessage },
    };

    const buffer = await downloadMediaMessage(
        normalizedMsg,
        'buffer',
        {},
        { reuploadRequest: sock.updateMediaMessage }
    );

    if (!buffer || !buffer.length) throw new Error('IMAGE_BUFFER_EMPTY');

    const tmpPath = path.join(os.tmpdir(), `bot-pp-${Date.now()}.jpg`);
    await fs.writeFile(tmpPath, buffer);

    try {
        await sock.updateProfilePicture(botJid, { url: tmpPath });
    } finally {
        await fs.rm(tmpPath, { force: true });
    }
};

const removeBotProfilePicture = async (sock) => {
    const botJid = resolveBotJid(sock);
    if (!botJid) throw new Error('BOT_JID_NOT_FOUND');
    await sock.removeProfilePicture(botJid);
};

module.exports = {
    updateBotProfilePictureFromMessage,
    removeBotProfilePicture,
};
