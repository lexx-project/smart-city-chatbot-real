const { isAdminJid } = require('../services/adminService');
const { getCmsMessages, updateCmsMessage } = require('../services/botFlowService');
const { startAdminSession, getAdminSession, updateAdminSession, endAdminSession } = require('../services/adminSessionService');

const handleAdminMessage = async (sock, msg, bodyText = '') => {
    const jid = msg?.key?.remoteJid;
    const pushName = msg.pushName || 'Admin';
    if (!jid) return false;

    const text = String(bodyText || '').trim();

    const isAdmin = await isAdminJid(sock, jid, pushName);
    if (!isAdmin) return false;

    let session = getAdminSession(jid);

    if (text.toLowerCase() === '/cancel') {
        if (session) {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: '✅ Mode Pengaturan dibatalkan.' });
        } else {
            await sock.sendMessage(jid, { text: 'Tidak ada pengaturan yang sedang aktif.' });
        }
        return true;
    }

    if (text.toLowerCase() === '/setting') {
        await sock.sendMessage(jid, { text: '⏳ _Mengambil daftar pesan dari server..._' });

        const messages = await getCmsMessages();
        if (!messages || messages.length === 0) {
            await sock.sendMessage(jid, { text: '❌ Gagal memuat pesan. Pastikan bot memiliki akses login admin ke backend.' });
            return true;
        }

        session = startAdminSession(jid);
        session.data.messagesList = messages;

        let reply = '⚙️ *PENGATURAN TEKS BOT*\n\nSilakan pilih pesan yang ingin diubah:\n\n';
        messages.forEach((m, index) => {
            const shortText = m.messageText.length > 40 ? m.messageText.substring(0, 40) + '...' : m.messageText;
            reply += `*${index + 1}.* [${m.messageKey}]\n💬 _"${shortText}"_\n\n`;
        });

        reply += '👉 _Balas dengan angka (contoh: 1)._\n🛑 _Ketik /cancel untuk membatalkan._';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    if (session) {
        if (session.step === 'SELECT_MESSAGE') {
            const choice = parseInt(text);
            const messages = session.data.messagesList;

            if (isNaN(choice) || choice < 1 || choice > messages.length) {
                await sock.sendMessage(jid, { text: '❌ Pilihan tidak valid. Balas dengan angka yang tertera di menu.' });
                return true;
            }

            const selectedMsg = messages[choice - 1];
            updateAdminSession(jid, { step: 'AWAITING_INPUT', data: { ...session.data, selectedMsg } });

            let reply = `📝 *UBAH PESAN: ${selectedMsg.messageKey}*\n\n`;
            reply += `*Teks Saat Ini:*\n${selectedMsg.messageText}\n\n`;
            reply += `✏️ _Silakan ketik teks pesan yang baru sekarang._\n🛑 _Ketik /cancel untuk batal._`;

            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        if (session.step === 'AWAITING_INPUT') {
            const selectedMsg = session.data.selectedMsg;
            await sock.sendMessage(jid, { text: '⏳ _Menyimpan perubahan ke server..._' });

            const result = await updateCmsMessage(selectedMsg.id, { messageText: text });

            if (result) {
                await sock.sendMessage(jid, { text: `✅ *BERHASIL!*\n\nTeks untuk *${selectedMsg.messageKey}* telah diperbarui.` });
            } else {
                await sock.sendMessage(jid, { text: `❌ *GAGAL!*\n\nTerjadi kesalahan saat menyimpan data.` });
            }

            endAdminSession(jid);
            return true;
        }
    }

    return false;
};

module.exports = { handleAdminMessage };
