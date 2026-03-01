const { getSession, startSession, updateSession, endSession } = require('../services/wargaSessionService');
const { getAdminSettings, isAdminJid } = require('../services/adminService');
const { getMainMenu, getStepById } = require('../services/botFlowService');

const handleWargaMessage = async (sock, msg, bodyText = '') => {
    const jid = msg?.key?.remoteJid;
    if (!jid) return false;

    const pushName = msg.pushName || 'Warga';
    const [isAdmin, adminSettings] = await Promise.all([
        isAdminJid(sock, jid, pushName),
        getAdminSettings()
    ]);

    if (isAdmin && bodyText.startsWith('/')) return false;

    const normalizedText = String(bodyText || '').trim();
    if (!normalizedText) return;

    let session = getSession(jid);

    // ==========================================
    // HELPER: Merakit Teks Pesan + Daftar Pilihan
    // ==========================================
    const buildMenuMessage = (stepData) => {
        let text = '';

        // 1. Masukkan pesan dari BE (jika ada)
        if (stepData.messages && stepData.messages.length > 0) {
            text += stepData.messages.map(m => m.messageText).join('\n\n') + '\n\n';
        }

        // 2. Masukkan daftar anak menu / pilihan (TIDAK PAKAI ELSE IF)
        if (stepData.children && stepData.children.length > 0) {
            stepData.children.forEach((child, index) => {
                const no = child.stepOrder || (index + 1);
                // Bersihkan underscore dari stepKey agar enak dibaca (contoh: Laporan_Jalan_Rusak -> Laporan Jalan Rusak)
                const label = child.stepKey ? child.stepKey.replace(/_/g, ' ') : (child.title || 'Menu');
                text += `*${no}.* ${label}\n`;
            });
            text += `\n_Ketik angka pilihan Anda._`;
        }

        return text.trim();
    };

    // ==========================================
    // KONDISI 1: SESI BARU (Menu Utama)
    // ==========================================
    if (!session) {
        const rawMenu = await getMainMenu();
        const mainMenu = rawMenu?.data || rawMenu;

        if (!mainMenu || !mainMenu.id) {
            await sock.sendMessage(jid, { text: 'Mohon maaf, layanan sistem sedang mengalami gangguan. Silakan coba lagi nanti.' });
            return true;
        }

        session = startSession(jid, mainMenu.id);

        let msgToSend = '';
        if (adminSettings.GREETING_MSG) {
            msgToSend += `${adminSettings.GREETING_MSG}\n\n`;
        }

        msgToSend += buildMenuMessage(mainMenu);

        await sock.sendMessage(jid, { text: msgToSend });
        return true;
    }

    // ==========================================
    // KONDISI 2: EVALUASI JAWABAN & CARI NEXT STEP
    // ==========================================
    const rawCurrent = await getStepById(session.currentStepId);
    const currentStep = rawCurrent?.data || rawCurrent;

    if (!currentStep) {
        await sock.sendMessage(jid, { text: 'Sesi tidak valid. Silakan mulai ulang dengan pesan baru.' });
        endSession(jid);
        return true;
    }

    const children = currentStep.children || [];
    let nextStepId = null;

    if (children.length === 0) {
        // STEP TERAKHIR (Formulir selesai)
        // TODO: Hit API Backend POST /tickets untuk menyimpan jawaban laporannya

        const closingMsg = adminSettings.SESSION_END_TEXT || 'Terima kasih, laporan/data Anda telah berhasil dicatat dan akan segera diproses.';
        await sock.sendMessage(jid, { text: `✅ *BERHASIL*\n\n${closingMsg}` });

        endSession(jid);
        return true;
    }
    else if (children.length === 1) {
        // ALUR LURUS (Contoh: Setelah isi alamat, pasti lanjut ke isi deskripsi)
        nextStepId = children[0].id;
    }
    else {
        // ALUR BERCABANG (Harus memilih angka)
        const selectedChild = children.find(c =>
            String(c.stepOrder) === normalizedText ||
            (c.stepKey && c.stepKey.toLowerCase() === normalizedText.toLowerCase())
        );

        if (!selectedChild) {
            await sock.sendMessage(jid, { text: '❌ Pilihan tidak valid. Silakan balas dengan angka yang sesuai menu di atas.' });
            updateSession(jid); // Refresh timer
            return true;
        }
        nextStepId = selectedChild.id;
    }

    // ==========================================
    // KONDISI 3: KIRIM PESAN STEP BERIKUTNYA
    // ==========================================
    const rawNext = await getStepById(nextStepId);
    const nextStep = rawNext?.data || rawNext;

    if (!nextStep) {
        await sock.sendMessage(jid, { text: 'Maaf, sistem tidak dapat memuat langkah selanjutnya.' });
        return true;
    }

    updateSession(jid, { currentStepId: nextStep.id });

    let nextMsg = buildMenuMessage(nextStep);
    if (!nextMsg) nextMsg = "Lanjut ke tahap berikutnya...";

    await sock.sendMessage(jid, { text: nextMsg });
    return true;
};

module.exports = { handleWargaMessage };
