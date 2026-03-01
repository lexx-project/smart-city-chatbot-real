const unwrapMessage = (message) => {
    if (!message) return {};

    let current = message;
    let guard = 0;

    while (guard < 5) {
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            guard += 1;
            continue;
        }

        if (current.viewOnceMessage?.message) {
            current = current.viewOnceMessage.message;
            guard += 1;
            continue;
        }

        if (current.viewOnceMessageV2?.message) {
            current = current.viewOnceMessageV2.message;
            guard += 1;
            continue;
        }

        if (current.viewOnceMessageV2Extension?.message) {
            current = current.viewOnceMessageV2Extension.message;
            guard += 1;
            continue;
        }

        break;
    }

    return current;
};

const extractBodyText = (msg) => {
    const rawMessage = unwrapMessage(msg?.message || {});
    let bodyText = '';
    const interactiveResp = rawMessage?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;

    if (interactiveResp) {
        try {
            const parsedParams = JSON.parse(interactiveResp);
            bodyText = parsedParams.id;
        } catch {
            bodyText = '';
        }
    } else {
        bodyText = (
            rawMessage?.conversation ||
            rawMessage?.extendedTextMessage?.text ||
            rawMessage?.imageMessage?.caption ||
            rawMessage?.videoMessage?.caption ||
            rawMessage?.buttonsResponseMessage?.selectedDisplayText ||
            rawMessage?.listResponseMessage?.title ||
            rawMessage?.templateButtonReplyMessage?.selectedDisplayText ||
            ''
        ).trim();
    }

    return bodyText;
};

const shouldSkipMessage = (msg) => {
    if (!msg?.message) return true;
    if (msg.key?.fromMe) return true;
    if (msg.key?.remoteJid === 'status@broadcast') return true;
    return false;
};

const isStaleMessage = (msg, maxAgeSeconds = 60) => {
    const messageTime = Number(msg?.messageTimestamp || 0);
    const currentTime = Math.floor(Date.now() / 1000);
    return currentTime - messageTime > maxAgeSeconds;
};

module.exports = {
    unwrapMessage,
    extractBodyText,
    shouldSkipMessage,
    isStaleMessage,
};
