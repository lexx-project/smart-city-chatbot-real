const { getSession, startSession, updateSession, endSession } = require('../services/wargaSessionService');
const { getAdminSettings, isAdminJid } = require('../services/adminService');
const { getMainMenu, getStepById } = require('../services/botFlowService');

const handleWargaMessage = async (sock, msg, bodyText = '') => {
    const jid = msg?.key?.remoteJid;
    if (!jid) return false;

    const pushName = msg.pushName || 'Warga';

    // Cek status Admin (dengan oper variabel sock dan pushName untuk auto-LID)
    const [isAdmin, adminSettings] = await Promise.all([
        isAdminJid(sock, jid, pushName),
        getAdminSettings(),
    ]);

    // Jika Admin (dan command diawali '/'), biarkan adminController yang menangani
    if (isAdmin && bodyText.startsWith('/')) return false;

    const normalizedText = String(bodyText || '').trim();
    if (!normalizedText) return;

    let session = getSession(jid);

    // ==========================================
    // KONDISI 1: SESI BARU (Belum ada sesi aktif)
    // ==========================================
    if (!session) {
        const mainMenu = await getMainMenu();
        if (!mainMenu) {
            await sock.sendMessage(jid, { text: 'Mohon maaf, layanan sistem sedang mengalami gangguan. Silakan coba lagi nanti.' });
            return true;
        }

        // Mulai sesi baru dengan ID menu utama
        session = startSession(jid, mainMenu.id, mainMenu.flowMode);

        // Susun pesan sapaan dari Admin Settings + Pesan dari Flow Menu
        const greeting = adminSettings.GREETING_MSG || 'Halo! Selamat datang di Layanan Smart City.';

        let msgToSend = `${greeting}\n\n`;
        // Gabungkan semua pesan di step ini
        if (mainMenu.messages && mainMenu.messages.length > 0) {
            msgToSend += mainMenu.messages.map((m) => m.messageContent).join('\n\n') + '\n\n';
        }
        // Susun pilihan anak menu (children)
        if (mainMenu.children && mainMenu.children.length > 0) {
            mainMenu.children.forEach((child) => {
                msgToSend += `*${child.keyword}.* ${child.title}\n`;
            });
            msgToSend += `\n_Ketik angka pilihan Anda._`;
        }

        await sock.sendMessage(jid, { text: msgToSend });
        return true;
    }

    // ==========================================
    // KONDISI 2: AWAIT_REPLY (Menunggu teks panjang, misal Pengaduan)
    // ==========================================
    if (session.flowMode === 'await_reply') {
        await sock.sendMessage(jid, { text: '⏳ _Laporan/Data Anda sedang kami proses ke dalam sistem..._' });

        // TODO: Integrasi ke endpoint POST /tickets di Backend NestJS nanti di sini
        // Untuk sekarang, kita simulasikan sukses

        const closingMsg = adminSettings.SESSION_END_TEXT || 'Terima kasih, laporan Anda telah diterima. Sesi ini telah diakhiri.';
        await sock.sendMessage(jid, { text: `✅ *BERHASIL*\n\n${closingMsg}` });

        endSession(jid);
        return true;
    }

    // ==========================================
    // KONDISI 3: NAVIGASI MENU (Warga memilih angka/keyword)
    // ==========================================
    // Tarik data step saat ini dari BE untuk melihat apakah keyword warga valid
    const currentStep = await getStepById(session.currentStepId);

    if (!currentStep || !currentStep.children || currentStep.children.length === 0) {
        // Jika step rusak atau tidak punya anak menu, akhiri sesi
        await sock.sendMessage(jid, { text: 'Sesi berakhir karena tidak ada pilihan lebih lanjut. Silakan kirim pesan baru untuk memulai ulang.' });
        endSession(jid);
        return true;
    }

    // Cari apakah input warga cocok dengan keyword salah satu children
    const selectedChild = currentStep.children.find((c) => c.keyword.toLowerCase() === normalizedText.toLowerCase());

    if (!selectedChild) {
        await sock.sendMessage(jid, { text: '❌ Pilihan tidak valid. Silakan ketik keyword/angka yang sesuai dengan menu di atas.' });
        updateSession(jid); // Refresh timer
        return true;
    }

    // Ambil detail step anak yang dipilih
    const nextStep = await getStepById(selectedChild.id);
    if (!nextStep) {
        await sock.sendMessage(jid, { text: 'Maaf, menu tersebut sedang tidak dapat diakses.' });
        return true;
    }

    // Update sesi dengan ID step yang baru
    updateSession(jid, { currentStepId: nextStep.id, flowMode: nextStep.flowMode });

    // Susun pesan untuk step baru
    let msgToSend = '';
    if (nextStep.messages && nextStep.messages.length > 0) {
        msgToSend += nextStep.messages.map((m) => m.messageContent).join('\n\n') + '\n\n';
    }

    if (nextStep.flowMode !== 'await_reply' && nextStep.children && nextStep.children.length > 0) {
        nextStep.children.forEach((child) => {
            msgToSend += `*${child.keyword}.* ${child.title}\n`;
        });
        msgToSend += `\n_Ketik angka pilihan Anda._`;
    }

    await sock.sendMessage(jid, { text: msgToSend });

    // Jika step baru ini tidak punya lanjutan dan bukan await_reply, langsung matikan sesi
    if (nextStep.flowMode === 'static' && (!nextStep.children || nextStep.children.length === 0)) {
        endSession(jid);
    }

    return true;
};

module.exports = {
    handleWargaMessage,
};
