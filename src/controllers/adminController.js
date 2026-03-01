const { normalizeToJid, displayAdminNumber } = require('../services/lidService');
const { isAdminJid, addAdminJid, listAdminJids, removeAdminJid, getAdminSettings } = require('../services/adminService');

const sendAccessDenied = async (sock, jid, command) => {
    await sock.sendMessage(jid, { text: `Akses ditolak. Hanya admin yang bisa menggunakan ${command}.` });
};

const handleAdminMessage = async (sock, msg, bodyText = '') => {
    const jid = msg?.key?.remoteJid;
    if (!jid) return false;

    const text = String(bodyText || '').trim();
    if (!text.startsWith('/')) return false;

    const normalized = text.toLowerCase();
    const isAdmin = await isAdminJid(sock, jid, msg?.pushName || 'Admin');

    if (normalized === '/menuadmin') {
        if (!isAdmin) {
            await sendAccessDenied(sock, jid, '/menuadmin');
            return true;
        }

        await sock.sendMessage(jid, {
            text: [
                'Daftar command admin:',
                '',
                '1. /menuadmin',
                '2. /setting',
                '3. /addadmin 628xxxxxxxxxx',
                '4. /listadmin',
                '5. /deladmin 628xxxxxxxxxx',
                '6. /totalchat (nonaktif sementara)',
                '7. /totalsesi (nonaktif sementara)',
                '8. /batal',
            ].join('\n'),
        });
        return true;
    }

    if (normalized === '/batal') {
        if (!isAdmin) {
            await sendAccessDenied(sock, jid, '/batal');
            return true;
        }

        await sock.sendMessage(jid, { text: 'Tidak ada flow admin aktif yang perlu dibatalkan.' });
        return true;
    }

    if (normalized === '/setting') {
        if (!isAdmin) {
            await sendAccessDenied(sock, jid, '/setting');
            return true;
        }

        const settings = await getAdminSettings();
        await sock.sendMessage(jid, {
            text: [
                'Ringkasan Bot Settings (read-only):',
                '',
                `GREETING_MSG: ${settings.GREETING_MSG || '-'}`,
                `SESSION_END_TEXT: ${settings.SESSION_END_TEXT || '-'}`,
                `TIMEOUT_SEC: ${settings.TIMEOUT_SEC || '-'}`,
                '',
                'Perubahan settings via WhatsApp command dinonaktifkan sementara.',
            ].join('\n'),
        });
        return true;
    }

    if (normalized.startsWith('/addadmin')) {
        if (!isAdmin) {
            await sendAccessDenied(sock, jid, '/addadmin');
            return true;
        }

        const candidate = text.split(/\s+/)[1] || '';
        const targetJid = normalizeToJid(candidate);
        if (!targetJid) {
            await sock.sendMessage(jid, { text: 'Format salah. Gunakan: /addadmin 628xxxxxxxxxx' });
            return true;
        }

        const admins = await addAdminJid(targetJid);
        await sock.sendMessage(jid, { text: `Admin runtime ditambahkan: ${targetJid}\nTotal admin terdaftar: ${admins.length}` });
        return true;
    }

    if (normalized === '/listadmin') {
        if (!isAdmin) {
            await sendAccessDenied(sock, jid, '/listadmin');
            return true;
        }

        const admins = await listAdminJids();
        const lines = [];
        for (let index = 0; index < admins.length; index += 1) {
            const numberOnly = await displayAdminNumber(admins[index]);
            lines.push(`${index + 1}. ${numberOnly || admins[index]}`);
        }

        await sock.sendMessage(jid, { text: `Daftar admin saat ini:\n\n${lines.join('\n')}` });
        return true;
    }

    if (normalized.startsWith('/deladmin')) {
        if (!isAdmin) {
            await sendAccessDenied(sock, jid, '/deladmin');
            return true;
        }

        const candidate = text.split(/\s+/)[1] || '';
        if (!candidate) {
            await sock.sendMessage(jid, { text: 'Format salah. Gunakan: /deladmin 628xxxxxxxxxx' });
            return true;
        }

        const result = await removeAdminJid(candidate);
        if (!result.removed) {
            await sock.sendMessage(jid, { text: 'Admin tidak ditemukan pada override runtime.' });
            return true;
        }

        await sock.sendMessage(jid, { text: `Admin runtime dihapus: ${candidate}` });
        return true;
    }

    if (normalized === '/totalchat' || normalized === '/totalsesi') {
        if (!isAdmin) {
            await sendAccessDenied(sock, jid, normalized); 
            return true;
        }

        await sock.sendMessage(jid, {
            text: 'Fitur statistik sedang dinonaktifkan sementara selama migrasi ke Backend NestJS.',
        });
        return true;
    }

    return false;
};

module.exports = {
    handleAdminMessage,
};
