const C = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    magenta: '\x1b[35m',
    blue: '\x1b[34m',
};

const color = (code, text) => `${code}${text}${C.reset}`;

const normalizeSender = (jid = '') => jid.replace('@s.whatsapp.net', '').replace('@g.us', '');

const logIncomingChat = (msg, roleLabel) => {
    const jid = msg?.key?.remoteJid || '-';
    const sender = normalizeSender(msg?.key?.participant || jid);
    const payload = (msg?.bodyText || '').trim() || '[non-text]';
    const time = new Date().toLocaleString('id-ID', { hour12: false });

    const line =
        `${color(C.dim, `[${time}]`)} ` +
        `${color(C.cyan, '[CHAT]')} ` +
        `${color(C.magenta, roleLabel)} ` +
        `${color(C.blue, sender)} ` +
        `${color(C.yellow, '->')} ` +
        `${color(C.green, payload)}`;

    console.log(line);
};

module.exports = {
    logIncomingChat,
};
