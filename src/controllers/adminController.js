const { isAdminJid } = require('../services/adminService');
const { getCmsMessages, updateCmsMessage, createCmsFlow, createCmsStep, getBotSettings, getMainMenu } = require('../services/botFlowService');
const { startAdminSession, getAdminSession, updateAdminSession, endAdminSession, getAuthenticatedStaff } = require('../services/adminSessionService');
const { getAdminTimeout, getAdminTimeoutText, updateAdminTimeout, updateAdminTimeoutText } = require('../services/adminSettingsService');
const { nestClient } = require('../api/nestClient');
const { getAdminToken } = require('../services/adminAuthService');


// ═══════════════════════════════════════════════════════
//  KONFIGURASI PENGATURAN TEKS
// ═══════════════════════════════════════════════════════

const humanizeKey = (messageKey) => {
    if (!messageKey) return 'Pesan Tanpa Nama';
    const key = messageKey.toLowerCase();

    if (key === 'greeting') return '👋 Pesan Sambutan Utama';
    if (key === 'success') return '✅ Pesan Berhasil (Sukses)';
    if (key === 'error') return '❌ Pesan Error Umum';
    if (key === 'timeout') return '⏰ Pesan Waktu Habis';
    if (key === 'session_expired') return '⏳ Sesi Kedaluwarsa';
    if (key === 'invalid_choice') return '🚫 Pilihan Tidak Valid';
    if (key === 'category_prompt') return '📂 Prompt Pilih Kategori';
    if (key === 'description_prompt') return '📝 Prompt Deskripsi Detail';

    return messageKey.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

// ═══════════════════════════════════════════════════════
//  UTILITAS
// ═══════════════════════════════════════════════════════

/**
 * Mendeteksi placeholder/variabel dalam teks pesan.
 * Mengembalikan array nama variabel, misal: ['name', 'ticketNumber']
 */
const detectPlaceholders = (text) => {
    if (!text) return [];
    const matches = text.match(/\{(\w+)\}/g);
    if (!matches) return [];
    return [...new Set(matches.map((m) => m.replace(/[{}]/g, '')))];
};

/**
 * Memotong teks panjang agar preview tetap ringkas.
 */
const truncateText = (text, maxLen = 60) => {
    if (!text) return '(kosong)';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '...';
};

// ═══════════════════════════════════════════════════════
//  HANDLER UTAMA
// ═══════════════════════════════════════════════════════

const handleAdminMessage = async (sock, msg, bodyText = '') => {
    const jid = msg?.key?.remoteJid;
    const pushName = msg.pushName || 'Admin';
    if (!jid) return false;

    const text = String(bodyText || '').trim();

    const staff = getAuthenticatedStaff(jid);
    const isAdmin = staff && staff.role && staff.role.toUpperCase().includes('ADMIN');
    if (!isAdmin) return false;

    let session = getAdminSession(jid);

    // ────────────────────────────────────────────────────
    //  /cancel — Batalkan di tahap mana pun
    // ────────────────────────────────────────────────────
    if (text.toLowerCase() === '/cancel') {
        if (session) {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: '✅ Mode Pengaturan dibatalkan.' });
        } else {
            await sock.sendMessage(jid, { text: 'ℹ️ Tidak ada pengaturan yang sedang aktif.' });
        }
        return true;
    }

    // ────────────────────────────────────────────────────
    //  /setting — Mulai wizard pengaturan
    // ────────────────────────────────────────────────────
    if (text.toLowerCase() === '/setting') {
        await sock.sendMessage(jid, { text: '⏳ _Sinkronisasi dengan Web Dashboard..._' });

        try {
            const [messages, flowsRes] = await Promise.all([
                getCmsMessages(),
                nestClient.get('/cms/bot-flow/flows', {
                    headers: { Authorization: `Bearer ${await getAdminToken()}` },
                    params: { limit: 100 }
                })
            ]);

            const flows = flowsRes.data?.data || flowsRes.data || [];

            if (!messages || !flows) throw new Error("Data kosong dari BE");

            session = startAdminSession(jid);

            // GROUPING LOGIC (Mirrors Dashboard)
            const flowSubGroups = flows.map(f => ({ id: f.id, label: `📝 Flow: ${f.flowName}`, messages: [] }));

            const groups = [
                { id: 'system', label: '⚙️ Pesan Sistem & Notifikasi', messages: [] },
                { id: 'menu', label: '📋 Menu & Navigasi', messages: [] },
                { id: 'flows', label: '📝 Alur Layanan (Flows)', subGroups: flowSubGroups },
                { id: 'other', label: '📦 Pesan Lainnya', messages: [] }
            ];

            // DISTRIBUTE MESSAGES
            messages.forEach(msg => {
                // If message belongs to a flow step
                if (msg.flowStep && msg.flowStep.flowId) {
                    const flowGroup = groups[2].subGroups.find(g => g.id === msg.flowStep.flowId);
                    if (flowGroup) {
                        flowGroup.messages.push(msg);
                        return;
                    }
                }

                const key = (msg.messageKey || '').toLowerCase();

                // System Messages
                if (['greeting', 'error', 'success', 'timeout', 'session_expired', 'invalid_choice', 'ticket_status_update'].includes(key)) {
                    groups[0].messages.push(msg);
                    return;
                }

                // Menu Messages
                if (['category_prompt', 'sub_category_prompt', 'category_selected', 'description_prompt', 'confirmation_prompt', 'no_categories'].includes(key)) {
                    groups[1].messages.push(msg);
                    return;
                }

                // Fallback
                groups[3].messages.push(msg);
            });

            // CLEANUP EMPTY GROUPS
            groups[2].subGroups = groups[2].subGroups.filter(g => (g.messages || []).length > 0);
            const activeGroups = groups.filter(g => g.id === 'flows' ? (g.subGroups || []).length > 0 : (g.messages || []).length > 0);

            // Tambahkan Pengaturan Timeout Sesi secara manual di akhir daftar
            activeGroups.push({
                id: 'timeout_setting',
                label: '⏱️ Pengaturan Timeout Sesi',
                messages: []
            });

            session.data.groups = activeGroups;

            let reply = '⚙️ *PENGATURAN TEKS BOT (SYNCED)*\n';
            reply += '📍 _Menu Utama_\n━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += 'Pilih kategori pesan yang ingin dikelola:\n\n';

            activeGroups.forEach((g, idx) => {
                const count = g.id === 'flows' ? g.subGroups.length + ' layanan' : (g.messages || []).length + ' pesan';
                reply += `*${idx + 1}.* ${g.label} _(${count})_\n`;
            });

            reply += '\n━━━━━━━━━━━━━━━━━━━━━\n👉 _Balas dengan angka (contoh: 1)_\n🛑 _Ketik /cancel untuk membatalkan_';
            await sock.sendMessage(jid, { text: reply });
            return true;

        } catch (err) {
            console.error('[ADMIN_CTRL] /setting error:', err?.message);
            await sock.sendMessage(jid, { text: '❌ *GAGAL MEMUAT DATA*\nPastikan koneksi ke Backend aman.' });
            return true;
        }
    }

    // ────────────────────────────────────────────────────
    //  /buildmenu — Wizard buat Menu & Pertanyaan baru
    // ────────────────────────────────────────────────────
    if (text.toLowerCase() === '/buildmenu') {
        if (session) {
            await sock.sendMessage(jid, {
                text: '⚠️ Anda sudah dalam sesi pengaturan. Ketik /cancel dulu untuk memulai wizard baru.',
            });
            return true;
        }

        session = startAdminSession(jid);
        updateAdminSession(jid, {
            step: 'BUILD_FLOW_TITLE',
            data: { wizard: 'buildmenu' },
        });

        let reply = '🔨 *WIZARD: BUAT MENU LAYANAN BARU*\n';
        reply += '📍 _Langkah 1 dari 2: Data Menu_\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += '📝 Silakan masukkan *Nama/Judul Menu Layanan*.\n\n';
        reply += '_Contoh: Laporan Jalan Rusak_\n\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n';
        reply += '🛑 _Ketik /cancel untuk membatalkan_';

        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ════════════════════════════════════════════════════
    //  SESSION-BASED STEPS
    // ════════════════════════════════════════════════════

    if (!session) return false;

    // ────────────────────────────────────────────────────
    //  STEP 1: SELECT_CATEGORY
    // ────────────────────────────────────────────────────
    if (session.step === 'SELECT_CATEGORY') {
        const groups = session.data.groups;
        const choice = parseInt(text);

        if (isNaN(choice) || choice < 1 || choice > groups.length) {
            await sock.sendMessage(jid, {
                text: '❌ Pilihan tidak valid. Balas dengan angka kategori yang tertera di menu.',
            });
            return true;
        }

        const selectedGroup = groups[choice - 1];

        if (selectedGroup.id === 'flows') {
            updateAdminSession(jid, { step: 'SELECT_FLOW_DOMAIN', data: { ...session.data, selectedGroup } });

            let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${selectedGroup.label}_\n━━━━━━━━━━━━━━━━━━━━━\n\nPilih jenis layanan:\n\n`;

            selectedGroup.subGroups.forEach((g, idx) => {
                reply += `*${idx + 1}.* ${g.label} _(${(g.messages || []).length} pesan)_\n`;
            });

            reply += '\n━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Kembali\n👉 _Balas dengan angka_\n🛑 _Ketik /cancel untuk membatalkan_';
            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        if (selectedGroup.id === 'timeout_setting') {
            updateAdminSession(jid, { step: 'SELECT_TIMEOUT_OPTION', data: { ...session.data, selectedGroup } });

            const currentTimeout = getAdminTimeout();
            const currentText = getAdminTimeoutText();
            let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${selectedGroup.label}_\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
            reply += `Pilih pengaturan yang ingin diubah:\n\n`;
            reply += `*1.* ⏱️ Durasi Timeout: _${currentTimeout} detik_\n`;
            reply += `*2.* 💬 Pesan Timeout:\n   _"${truncateText(currentText, 50)}"_\n\n`;
            reply += '━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Kembali\n👉 _Balas dengan angka_';

            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        updateAdminSession(jid, {
            step: 'SELECT_MESSAGE',
            data: {
                ...session.data,
                selectedGroup,
                categoryIndex: choice,
            },
        });

        let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
        reply += `📍 _Menu Utama > ${selectedGroup.label}_\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `Pesan dalam kategori *${selectedGroup.label}*:\n\n`;

        selectedGroup.messages.forEach((m, idx) => {
            const label = humanizeKey(m.messageKey);
            const preview = truncateText(m.messageText, 50);
            reply += `*${idx + 1}.* ${label}\n`;
            reply += `   💬 _"${preview}"_\n\n`;
        });

        reply += '━━━━━━━━━━━━━━━━━━━━━\n';
        reply += '*0.* ⬅️ Kembali ke daftar kategori\n';
        reply += '👉 _Balas dengan angka pesan yang ingin diubah_\n';
        reply += '🛑 _Ketik /cancel untuk membatalkan_';

        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  STEP 1b: SELECT_FLOW_DOMAIN
    // ────────────────────────────────────────────────────
    if (session.step === 'SELECT_FLOW_DOMAIN') {
        const selectedGroup = session.data.selectedGroup;

        if (text === '0') {
            updateAdminSession(jid, { step: 'SELECT_CATEGORY', data: { ...session.data, selectedGroup: undefined } });

            const groups = session.data.groups;
            let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
            reply += '📍 _Menu Utama_\n━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += 'Pilih kategori pesan yang ingin dikelola:\n\n';

            groups.forEach((g, idx) => {
                const count = g.id === 'flows' ? (g.subGroups || []).length + ' layanan' : (g.messages || []).length + ' pesan';
                reply += `*${idx + 1}.* ${g.label} _(${count})_\n`;
            });

            reply += '\n━━━━━━━━━━━━━━━━━━━━━\n👉 _Balas dengan angka (contoh: 1)_\n🛑 _Ketik /cancel untuk membatalkan_';
            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        const choice = parseInt(text);
        if (isNaN(choice) || choice < 1 || choice > selectedGroup.subGroups.length) {
            await sock.sendMessage(jid, { text: '❌ Pilihan tidak valid. Balas dengan angka layanan yang tertera, atau *0* untuk kembali.' });
            return true;
        }

        const selectedSub = selectedGroup.subGroups[choice - 1];
        updateAdminSession(jid, { step: 'SELECT_MESSAGE', data: { ...session.data, parentGroup: selectedGroup, selectedGroup: selectedSub } });

        let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${selectedGroup.label} > ${selectedSub.label}_\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
        reply += `Pesan dalam *${selectedSub.label}*:\n\n`;

        selectedSub.messages.forEach((m, idx) => {
            const label = humanizeKey(m.messageKey);
            const preview = truncateText(m.messageText, 50);
            reply += `*${idx + 1}.* ${label}\n`;
            reply += `   💬 _"${preview}"_\n\n`;
        });

        reply += '━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Kembali ke daftar layanan\n👉 _Balas dengan angka pesan yang ingin diubah_\n🛑 _Ketik /cancel untuk membatalkan_';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  STEP 1c: SELECT_TIMEOUT_OPTION
    // ────────────────────────────────────────────────────
    if (session.step === 'SELECT_TIMEOUT_OPTION') {
        const selectedGroup = session.data.selectedGroup;

        if (text === '0') {
            updateAdminSession(jid, { step: 'SELECT_CATEGORY', data: { ...session.data, selectedGroup: undefined } });

            const groups = session.data.groups;
            let reply = '⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama_\n━━━━━━━━━━━━━━━━━━━━━\n\nPilih kategori pesan yang ingin dikelola:\n\n';
            groups.forEach((g, idx) => {
                const count = g.id === 'flows' ? (g.subGroups || []).length + ' layanan' : (g.messages || []).length + ' pesan';
                reply += `*${idx + 1}.* ${g.label} _(${count})_\n`;
            });
            reply += '\n━━━━━━━━━━━━━━━━━━━━━\n👉 _Balas dengan angka (contoh: 1)_\n🛑 _Ketik /cancel untuk membatalkan_';
            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        if (text === '1') {
            updateAdminSession(jid, { step: 'AWAITING_TIMEOUT_DURATION_INPUT', data: { ...session.data, selectedGroup } });

            const currentTimeout = getAdminTimeout();
            let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${selectedGroup.label} > Durasi_\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
            reply += `⏱️ *Durasi Saat Ini:* ${currentTimeout} detik (${Math.round(currentTimeout / 60)} menit)\n\n`;
            reply += 'Masukkan durasi timeout baru dalam *detik* (minimal 60).\n\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Batal\n👉 _Balas dengan angka_';

            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        if (text === '2') {
            updateAdminSession(jid, { step: 'AWAITING_TIMEOUT_TEXT_INPUT', data: { ...session.data, selectedGroup } });

            const currentText = getAdminTimeoutText();
            let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${selectedGroup.label} > Teks_\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
            reply += `💬 *Pesan Timeout Saat Ini:*\n${currentText}\n\n`;
            reply += '✏️ _Silakan ketik pesan timeout yang baru sekarang._\n\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Batal';

            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        await sock.sendMessage(jid, { text: '❌ Pilihan tidak valid. Pilih 1 atau 2, atau *0* untuk kembali.' });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  STEP 1d: AWAITING_TIMEOUT_DURATION_INPUT
    // ────────────────────────────────────────────────────
    if (session.step === 'AWAITING_TIMEOUT_DURATION_INPUT') {
        const selectedGroup = session.data.selectedGroup;

        if (text === '0') {
            updateAdminSession(jid, { step: 'SELECT_TIMEOUT_OPTION', data: { ...session.data } });
            const currentTimeout = getAdminTimeout();
            const currentText = getAdminTimeoutText();
            let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${selectedGroup.label}_\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
            reply += `Pilih pengaturan yang ingin diubah:\n\n`;
            reply += `*1.* ⏱️ Durasi Timeout: _${currentTimeout} detik_\n`;
            reply += `*2.* 💬 Pesan Timeout:\n   _"${truncateText(currentText, 50)}"_\n\n`;
            reply += '━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Kembali\n👉 _Balas dengan angka_';
            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        const newTimeout = parseInt(text);
        if (isNaN(newTimeout) || newTimeout < 60) {
            await sock.sendMessage(jid, { text: '❌ Nilai tidak valid. Masukkan angka minimal *60* (detik), atau *0* untuk membatalkan.' });
            return true;
        }

        updateAdminTimeout(newTimeout);
        await sock.sendMessage(jid, { text: `✅ *BERHASIL*\nTimeout sesi admin telah diubah ke *${newTimeout} detik* (${Math.round(newTimeout / 60)} menit).` });

        updateAdminSession(jid, { step: 'SELECT_TIMEOUT_OPTION', data: { ...session.data } });
        const currentText = getAdminTimeoutText();
        let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${selectedGroup.label}_\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
        reply += `Pilih pengaturan yang ingin diubah:\n\n`;
        reply += `*1.* ⏱️ Durasi Timeout: _${newTimeout} detik_\n`;
        reply += `*2.* 💬 Pesan Timeout:\n   _"${truncateText(currentText, 50)}"_\n\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Kembali\n👉 _Balas dengan angka_';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  STEP 1e: AWAITING_TIMEOUT_TEXT_INPUT
    // ────────────────────────────────────────────────────
    if (session.step === 'AWAITING_TIMEOUT_TEXT_INPUT') {
        const selectedGroup = session.data.selectedGroup;

        if (text === '0') {
            updateAdminSession(jid, { step: 'SELECT_TIMEOUT_OPTION', data: { ...session.data } });
            const currentTimeout = getAdminTimeout();
            const currentText = getAdminTimeoutText();
            let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${selectedGroup.label}_\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
            reply += `Pilih pengaturan yang ingin diubah:\n\n`;
            reply += `*1.* ⏱️ Durasi Timeout: _${currentTimeout} detik_\n`;
            reply += `*2.* 💬 Pesan Timeout:\n   _"${truncateText(currentText, 50)}"_\n\n`;
            reply += '━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Kembali\n👉 _Balas dengan angka_';
            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        updateAdminTimeoutText(text);
        await sock.sendMessage(jid, { text: `✅ *BERHASIL*\nPesan timeout sesi admin telah diperbarui.` });

        updateAdminSession(jid, { step: 'SELECT_TIMEOUT_OPTION', data: { ...session.data } });
        const currentTimeout = getAdminTimeout();
        let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${selectedGroup.label}_\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
        reply += `Pilih pengaturan yang ingin diubah:\n\n`;
        reply += `*1.* ⏱️ Durasi Timeout: _${currentTimeout} detik_\n`;
        reply += `*2.* 💬 Pesan Timeout:\n   _"${truncateText(text, 50)}"_\n\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Kembali\n👉 _Balas dengan angka_';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  STEP 2: SELECT_MESSAGE (dalam kategori)
    // ────────────────────────────────────────────────────
    if (session.step === 'SELECT_MESSAGE') {
        const selectedGroup = session.data.selectedGroup;
        const parentGroup = session.data.parentGroup;

        // Opsi kembali
        if (text === '0') {
            if (parentGroup) {
                updateAdminSession(jid, {
                    step: 'SELECT_FLOW_DOMAIN',
                    data: {
                        ...session.data,
                        selectedGroup: parentGroup,
                        parentGroup: undefined,
                    },
                });

                let reply = `⚙️ *PENGATURAN TEKS BOT*\n📍 _Menu Utama > ${parentGroup.label}_\n━━━━━━━━━━━━━━━━━━━━━\n\nPilih jenis layanan:\n\n`;
                parentGroup.subGroups.forEach((g, idx) => {
                    reply += `*${idx + 1}.* ${g.label} _(${(g.messages || []).length} pesan)_\n`;
                });
                reply += '\n━━━━━━━━━━━━━━━━━━━━━\n*0.* ⬅️ Kembali\n👉 _Balas dengan angka_';
                await sock.sendMessage(jid, { text: reply });
                return true;
            }

            updateAdminSession(jid, {
                step: 'SELECT_CATEGORY',
                data: {
                    ...session.data,
                    selectedGroup: undefined,
                    categoryIndex: undefined,
                },
            });

            const groups = session.data.groups;
            let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
            reply += '📍 _Menu Utama_\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += 'Pilih kategori pesan yang ingin dikelola:\n\n';

            groups.forEach((g, idx) => {
                reply += `*${idx + 1}.* ${g.label} _(${g.id === 'flows' ? g.subGroups.length + ' layanan' : g.messages.length + ' pesan'})_\n`;
            });

            reply += '\n━━━━━━━━━━━━━━━━━━━━━\n';
            reply += '👉 _Balas dengan angka (contoh: 1)_\n';
            reply += '🛑 _Ketik /cancel untuk membatalkan_';

            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        const choice = parseInt(text);
        const categoryMessages = selectedGroup.messages;

        if (isNaN(choice) || choice < 1 || choice > categoryMessages.length) {
            await sock.sendMessage(jid, {
                text: '❌ Pilihan tidak valid. Balas dengan angka pesan yang tertera, atau *0* untuk kembali.',
            });
            return true;
        }

        const selectedMsg = categoryMessages[choice - 1];
        const placeholders = detectPlaceholders(selectedMsg.messageText);

        updateAdminSession(jid, {
            step: 'AWAITING_INPUT',
            data: {
                ...session.data,
                selectedMsg,
                messageIndex: choice,
                placeholders,
            },
        });

        const label = humanizeKey(selectedMsg.messageKey);
        const breadcrumb = session.data.parentGroup
            ? `${session.data.parentGroup.label} > ${selectedGroup.label}`
            : selectedGroup.label;

        let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
        reply += `📍 _Menu Utama > ${breadcrumb} > ${label}_\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `📝 *UBAH PESAN: ${label}*\n\n`;
        reply += `*Teks Saat Ini:*\n${selectedMsg.messageText}\n\n`;

        if (placeholders.length > 0) {
            reply += '⚠️ *PERHATIAN — Variabel Terdeteksi:*\n';
            placeholders.forEach((p) => {
                reply += `   • \`{${p}}\`\n`;
            });
            reply += '_Pastikan variabel di atas tetap ada dalam teks baru Anda!_\n\n';
        }

        reply += '━━━━━━━━━━━━━━━━━━━━━\n';
        reply += '✏️ _Silakan ketik teks pesan yang baru sekarang._\n';
        reply += '🛑 _Ketik /cancel untuk batal._';

        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  STEP 3: AWAITING_INPUT — Admin mengetik teks baru
    // ────────────────────────────────────────────────────
    if (session.step === 'AWAITING_INPUT') {
        const { selectedMsg, selectedGroup, placeholders } = session.data;
        const newText = text;

        // Cek apakah placeholder yang diperlukan masih ada di teks baru
        const missingPlaceholders = (placeholders || []).filter(
            (p) => !newText.includes(`{${p}}`)
        );

        updateAdminSession(jid, {
            step: 'CONFIRM_PREVIEW',
            data: {
                ...session.data,
                newText,
                missingPlaceholders,
            },
        });

        const label = humanizeKey(selectedMsg.messageKey);
        const breadcrumb = session.data.parentGroup
            ? `${session.data.parentGroup.label} > ${selectedGroup.label}`
            : selectedGroup.label;

        let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
        reply += `📍 _Menu Utama > ${breadcrumb} > ${label} > Preview_\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += '🔍 *PREVIEW PERUBAHAN*\n\n';
        reply += `📌 *Pesan:* ${label}\n\n`;
        reply += `📄 *Teks Lama:*\n${selectedMsg.messageText}\n\n`;
        reply += `✨ *Teks Baru:*\n${newText}\n\n`;

        if (missingPlaceholders.length > 0) {
            reply += '⚠️ *PERINGATAN:* Variabel berikut HILANG dari teks baru:\n';
            missingPlaceholders.forEach((p) => {
                reply += `   • \`{${p}}\` — tidak ditemukan!\n`;
            });
            reply += '_Bot mungkin error jika variabel ini dibutuhkan._\n\n';
        }

        reply += '━━━━━━━━━━━━━━━━━━━━━\n';
        reply += '✅ Ketik *Y* untuk menyimpan perubahan\n';
        reply += '❌ Ketik *N* untuk membatalkan & kembali\n';
        reply += '🛑 _Ketik /cancel untuk batal total._';

        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  STEP 4: CONFIRM_PREVIEW — Konfirmasi sebelum save
    // ────────────────────────────────────────────────────
    if (session.step === 'CONFIRM_PREVIEW') {
        const answer = text.toUpperCase();

        if (answer === 'N') {
            // Kembali ke SELECT_MESSAGE dalam grup
            const { selectedGroup } = session.data;

            updateAdminSession(jid, {
                step: 'SELECT_MESSAGE',
                data: {
                    ...session.data,
                    selectedMsg: undefined,
                    newText: undefined,
                    missingPlaceholders: undefined,
                    messageIndex: undefined,
                    placeholders: undefined,
                },
            });

            let reply = '↩️ _Perubahan dibatalkan._\n\n';
            reply += '⚙️ *PENGATURAN TEKS BOT*\n';
            reply += `📍 _Menu Utama > ${selectedGroup.label}_\n`;
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += `Pesan dalam *${selectedGroup.label}*:\n\n`;

            selectedGroup.messages.forEach((m, idx) => {
                const label = humanizeKey(m.messageKey);
                const preview = truncateText(m.messageText, 50);
                reply += `*${idx + 1}.* ${label}\n`;
                reply += `   💬 _"${preview}"_\n\n`;
            });

            reply += '━━━━━━━━━━━━━━━━━━━━━\n';
            reply += '*0.* ⬅️ Kembali ke daftar kategori\n';
            reply += '👉 _Balas dengan angka pesan yang ingin diubah_\n';
            reply += '🛑 _Ketik /cancel untuk membatalkan_';

            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        if (answer === 'Y') {
            const { selectedMsg, newText } = session.data;
            await sock.sendMessage(jid, { text: '⏳ _Menyimpan perubahan ke server..._' });

            let result;
            try {
                result = await updateCmsMessage(selectedMsg.id, { messageText: newText });
            } catch (err) {
                console.error('[ADMIN_CTRL] updateCmsMessage error:', err?.message);
                result = null;
            }

            if (result) {
                const label = humanizeKey(selectedMsg.messageKey);
                await sock.sendMessage(jid, {
                    text:
                        '✅ *BERHASIL DISIMPAN!*\n\n' +
                        `📌 *Pesan:* ${label}\n` +
                        `✨ *Teks Baru:* ${truncateText(newText, 80)}\n\n` +
                        '_Perubahan telah aktif. Ketik /setting untuk mengedit pesan lainnya._',
                });
            } else {
                await sock.sendMessage(jid, {
                    text:
                        '❌ *GAGAL MENYIMPAN*\n\n' +
                        'Terjadi kesalahan saat mengirim data ke backend.\n\n' +
                        '*Kemungkinan penyebab:*\n' +
                        '• Server NestJS tidak merespons\n' +
                        '• Token admin expired (akan di-refresh otomatis)\n' +
                        '• Data pesan tidak valid\n\n' +
                        '💡 _Cek log terminal bot untuk detail error._',
                });
            }

            endAdminSession(jid);
            return true;
        }

        // Input tidak valid (bukan Y atau N)
        await sock.sendMessage(jid, {
            text: '❌ Pilihan tidak valid. Ketik *Y* untuk simpan atau *N* untuk batal.',
        });
        return true;
    }

    // ════════════════════════════════════════════════════
    //  BUILD MENU WIZARD STEPS
    // ════════════════════════════════════════════════════

    // ────────────────────────────────────────────────────
    //  BUILD_FLOW_TITLE — Admin memasukkan nama menu
    // ────────────────────────────────────────────────────
    if (session.step === 'BUILD_FLOW_TITLE') {
        if (text.length < 3) {
            await sock.sendMessage(jid, { text: '❌ Nama menu terlalu pendek. Minimal 3 karakter.' });
            return true;
        }
        updateAdminSession(jid, { step: 'BUILD_FLOW_KEYWORD', data: { ...session.data, flowTitle: text } });

        let reply = '🔨 *WIZARD: BUAT MENU LAYANAN BARU*\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `✅ Judul: *${text}*\n\n`;
        reply += '🔑 Masukkan *Keyword/Slug* unik untuk menu ini.\n';
        reply += '_Huruf kecil, tanpa spasi (gunakan underscore)._\n\n';
        reply += '_Contoh: jalan_rusak_\n\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n🛑 _Ketik /cancel untuk membatalkan_';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  BUILD_FLOW_KEYWORD — Admin memasukkan keyword + simpan flow
    // ────────────────────────────────────────────────────
    if (session.step === 'BUILD_FLOW_KEYWORD') {
        const rawKeyword = text.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (rawKeyword.length < 2) {
            await sock.sendMessage(jid, { text: '❌ Keyword tidak valid. Minimal 2 karakter (huruf kecil & underscore).' });
            return true;
        }

        const keyword = `flow_${rawKeyword}`;
        const { flowTitle } = session.data;

        await sock.sendMessage(jid, { text: '⏳ _Menyimpan menu ke server..._' });

        let flowResult;
        try {
            flowResult = await createCmsFlow({ keyword, flowName: flowTitle, orderNumber: 0, isActive: true });
        } catch (err) {
            console.error('[BUILD_MENU] createCmsFlow error:', err?.message);
            flowResult = null;
        }

        if (!flowResult || !flowResult.id) {
            await sock.sendMessage(jid, {
                text: '❌ *GAGAL MEMBUAT MENU*\n\nServer backend tidak merespons atau data tidak valid.\n\n*Kemungkinan penyebab:*\n• Server NestJS belum berjalan\n• Keyword sudah digunakan\n• Kredensial admin tidak valid\n\n💡 _Cek log terminal bot untuk detail error._',
            });
            endAdminSession(jid);
            return true;
        }

        updateAdminSession(jid, {
            step: 'BUILD_MENU_TYPE',
            data: { ...session.data, flowKeyword: keyword, flowId: flowResult.id, stepCounter: 1, stepsCreated: 0 },
        });

        let reply = '🔨 *WIZARD: BUAT MENU LAYANAN BARU*\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `✅ Menu *"${flowTitle}"* berhasil disimpan!\n`;
        reply += `🔑 Keyword: \`${keyword}\`\n\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += '📌 Pilih *Tipe Menu*:\n\n';
        reply += '*1.* 📡 Informatif (Fetch API) — Menu yang menampilkan data dari API\n';
        reply += '*2.* 📝 Pengecekan (Warga Input) — Menu yang meminta input dari warga\n\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n👉 _Balas dengan angka (1-2)_\n🛑 _Ketik /cancel untuk membatalkan_';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  BUILD_MENU_TYPE — Pilih Informatif atau Pengecekan
    // ────────────────────────────────────────────────────
    if (session.step === 'BUILD_MENU_TYPE') {
        if (text !== '1' && text !== '2') {
            await sock.sendMessage(jid, { text: '❌ Pilihan tidak valid. Balas dengan angka *1* atau *2*.' });
            return true;
        }

        const menuType = text === '1' ? 'informatif' : 'pengecekan';

        if (menuType === 'informatif') {
            updateAdminSession(jid, { step: 'BUILD_INFO_URL', data: { ...session.data, menuType } });

            let reply = '🔨 *WIZARD: MENU INFORMATIF*\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += '📡 Masukkan *URL API* untuk menu ini.\n\n';
            reply += '_Contoh: https://api.kota.go.id/info/jadwal-pelayanan_\n\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n🛑 _Ketik /cancel untuk membatalkan_';
            await sock.sendMessage(jid, { text: reply });
        } else {
            updateAdminSession(jid, { step: 'BUILD_STEP_COUNT', data: { ...session.data, menuType } });

            let reply = '🔨 *WIZARD: MENU PENGECEKAN*\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += '📝 Berapa jumlah *Sub-Menu (Pertanyaan/Step)* yang ingin dibuat?\n\n';
            reply += '_Contoh: 3_\n\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n🛑 _Ketik /cancel untuk membatalkan_';
            await sock.sendMessage(jid, { text: reply });
        }
        return true;
    }

    // ════════════════════════════════════════════════════
    //  INFORMATIF BRANCH
    // ════════════════════════════════════════════════════

    // ────────────────────────────────────────────────────
    //  BUILD_INFO_URL — Admin memasukkan URL API
    // ────────────────────────────────────────────────────
    if (session.step === 'BUILD_INFO_URL') {
        if (!text.startsWith('http://') && !text.startsWith('https://')) {
            await sock.sendMessage(jid, { text: '❌ URL tidak valid. Harus diawali dengan *http://* atau *https://*.' });
            return true;
        }

        updateAdminSession(jid, { step: 'BUILD_INFO_TEMPLATE', data: { ...session.data, apiUrl: text } });

        let reply = '🔨 *WIZARD: MENU INFORMATIF*\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `✅ URL API: ${text}\n\n`;
        reply += '📄 Masukkan *Template Respon*.\n';
        reply += 'Gunakan `{data.key}` untuk variabel dari API.\n\n';
        reply += '_Contoh:_\n';
        reply += '_📋 *Jadwal Pelayanan*_\n';
        reply += '_Hari: {data.hari}_\n';
        reply += '_Jam: {data.jam}_\n\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n🛑 _Ketik /cancel untuk membatalkan_';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  BUILD_INFO_TEMPLATE — Admin memasukkan template respon + simpan step
    // ────────────────────────────────────────────────────
    if (session.step === 'BUILD_INFO_TEMPLATE') {
        if (text.length < 5) {
            await sock.sendMessage(jid, { text: '❌ Template terlalu pendek. Minimal 5 karakter.' });
            return true;
        }

        const { flowId, flowTitle, flowKeyword, apiUrl } = session.data;

        await sock.sendMessage(jid, { text: '⏳ _Menyimpan konfigurasi informatif ke server..._' });

        // Simpan step info untuk API URL
        let step1Result;
        try {
            step1Result = await createCmsStep({
                flowId,
                stepKey: 'fetch_api',
                stepOrder: 1,
                inputType: 'info',
                messageText: apiUrl,
                isRequired: false,
            });
        } catch (err) {
            console.error('[BUILD_MENU] createCmsStep (info url) error:', err?.message);
            step1Result = null;
        }

        // Simpan step template respon
        let step2Result;
        try {
            step2Result = await createCmsStep({
                flowId,
                stepKey: 'response_template',
                stepOrder: 2,
                inputType: 'info',
                messageText: text,
                isRequired: false,
            });
        } catch (err) {
            console.error('[BUILD_MENU] createCmsStep (info template) error:', err?.message);
            step2Result = null;
        }

        if (!step1Result || !step2Result) {
            await sock.sendMessage(jid, {
                text: '❌ *GAGAL MENYIMPAN KONFIGURASI*\n\nServer backend tidak merespons.\n💡 _Cek log terminal bot untuk detail error._',
            });
            endAdminSession(jid);
            return true;
        }

        let reply = '🎉 *MENU INFORMATIF BERHASIL DIBUAT!*\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `📋 *Menu:* ${flowTitle}\n`;
        reply += `🔑 *Keyword:* \`${flowKeyword}\`\n`;
        reply += `📡 *URL API:* ${apiUrl}\n`;
        reply += `📄 *Template:* _"${truncateText(text, 50)}"_\n\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += '_Menu sudah aktif dan siap digunakan!_\n';
        reply += '_Ketik /buildmenu untuk membuat menu baru lainnya._';

        await sock.sendMessage(jid, { text: reply });
        endAdminSession(jid);
        return true;
    }

    // ════════════════════════════════════════════════════
    //  PENGECEKAN BRANCH
    // ════════════════════════════════════════════════════

    // ────────────────────────────────────────────────────
    //  BUILD_STEP_COUNT — Admin menentukan jumlah step
    // ────────────────────────────────────────────────────
    if (session.step === 'BUILD_STEP_COUNT') {
        const totalSteps = parseInt(text, 10);
        if (isNaN(totalSteps) || totalSteps < 1 || totalSteps > 20) {
            await sock.sendMessage(jid, { text: '❌ Jumlah tidak valid. Masukkan angka antara *1-20*.' });
            return true;
        }

        updateAdminSession(jid, {
            step: 'BUILD_STEP_TEXT',
            data: { ...session.data, totalSteps, stepCounter: 1, stepsCreated: 0 },
        });

        let reply = '🔨 *WIZARD: MENU PENGECEKAN*\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `✅ Akan membuat *${totalSteps} pertanyaan*.\n\n`;
        reply += `📝 *Pertanyaan #1 dari ${totalSteps}*\n`;
        reply += 'Ketik teks pertanyaan yang akan dikirim bot ke warga.\n\n';
        reply += '_Contoh: Kirimkan foto jalan yang rusak_\n\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n🛑 _Ketik /cancel untuk membatalkan_';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  BUILD_STEP_TEXT — Admin memasukkan teks pertanyaan
    // ────────────────────────────────────────────────────
    if (session.step === 'BUILD_STEP_TEXT') {
        if (text.length < 5) {
            await sock.sendMessage(jid, { text: '❌ Teks pertanyaan terlalu pendek. Minimal 5 karakter.' });
            return true;
        }

        updateAdminSession(jid, { step: 'BUILD_STEP_TYPE', data: { ...session.data, currentStepText: text } });

        const { stepCounter, totalSteps } = session.data;
        let reply = '🔨 *WIZARD: BUAT PERTANYAAN*\n';
        reply += `📍 _Pertanyaan #${stepCounter} dari ${totalSteps} — Pilih Tipe_\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `📝 Teks: _"${truncateText(text, 60)}"_\n\n`;
        reply += 'Pilih *tipe input* yang diharapkan:\n\n';
        reply += '*1.* 💬 Text (Jawaban teks biasa)\n';
        reply += '*2.* 🔢 Number (Angka)\n';
        reply += '*3.* 📋 Select (Pilihan ganda)\n';
        reply += '*4.* ✅ Confirmation (Ya/Tidak)\n';
        reply += '*5.* ℹ️ Info (Pesan informatif, tidak perlu jawaban)\n\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n👉 _Balas dengan angka (1-5)_\n🛑 _Ketik /cancel untuk membatalkan_';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  BUILD_STEP_TYPE — Admin memilih tipe input
    // ────────────────────────────────────────────────────
    if (session.step === 'BUILD_STEP_TYPE') {
        const typeMap = { '1': 'text', '2': 'number', '3': 'select', '4': 'confirmation', '5': 'info' };
        const typeLabelMap = { '1': '💬 Text', '2': '🔢 Number', '3': '📋 Select', '4': '✅ Confirmation', '5': 'ℹ️ Info' };
        const selectedType = typeMap[text];

        if (!selectedType) {
            await sock.sendMessage(jid, { text: '❌ Pilihan tidak valid. Balas dengan angka *1-5*.' });
            return true;
        }

        updateAdminSession(jid, { step: 'BUILD_STEP_REQ', data: { ...session.data, currentStepType: selectedType } });

        const { stepCounter, totalSteps } = session.data;
        let reply = '🔨 *WIZARD: BUAT PERTANYAAN*\n';
        reply += `📍 _Pertanyaan #${stepCounter} dari ${totalSteps} — Wajib?_\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `📝 Teks: _"${truncateText(session.data.currentStepText, 50)}"_\n`;
        reply += `🔖 Tipe: *${typeLabelMap[text]}*\n\n`;
        reply += 'Apakah pertanyaan ini *wajib diisi* oleh warga?\n\n';
        reply += '*Y* = Ya, wajib\n*N* = Tidak, opsional\n\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n🛑 _Ketik /cancel untuk membatalkan_';
        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  BUILD_STEP_REQ — Wajib/opsional + simpan step + auto-loop
    // ────────────────────────────────────────────────────
    if (session.step === 'BUILD_STEP_REQ') {
        const answer = text.toUpperCase();
        if (answer !== 'Y' && answer !== 'N') {
            await sock.sendMessage(jid, { text: '❌ Pilihan tidak valid. Ketik *Y* (wajib) atau *N* (opsional).' });
            return true;
        }

        const isRequired = answer === 'Y';
        const { flowId, currentStepText, currentStepType, stepCounter, flowTitle, totalSteps } = session.data;
        const stepKeyword = `ask_${currentStepType}_${stepCounter}`;

        await sock.sendMessage(jid, { text: '⏳ _Menyimpan pertanyaan ke server..._' });

        let stepResult;
        try {
            stepResult = await createCmsStep({
                flowId,
                stepKey: stepKeyword,
                stepOrder: stepCounter,
                inputType: currentStepType,
                messageText: currentStepText,
                isRequired,
            });
        } catch (err) {
            console.error('[BUILD_MENU] createCmsStep error:', err?.message);
            stepResult = null;
        }

        if (!stepResult) {
            await sock.sendMessage(jid, {
                text: `❌ *GAGAL MENYIMPAN PERTANYAAN*\n\nServer backend tidak merespons.\n💡 _Cek log terminal bot untuk detail error._\n\n_Menu "${flowTitle}" tetap tersimpan._`,
            });
            endAdminSession(jid);
            return true;
        }

        const stepsCreated = (session.data.stepsCreated || 0) + 1;
        const nextStep = stepCounter + 1;
        const typeLabels = { text: '💬 Text', number: '🔢 Number', select: '📋 Select', confirmation: '✅ Confirmation', info: 'ℹ️ Info' };

        // Cek apakah masih ada step yang harus dibuat
        if (stepsCreated < totalSteps) {
            updateAdminSession(jid, {
                step: 'BUILD_STEP_TEXT',
                data: { ...session.data, stepsCreated, stepCounter: nextStep, currentStepText: undefined, currentStepType: undefined },
            });

            let reply = '🔨 *WIZARD: BUAT PERTANYAAN*\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += `✅ *Pertanyaan #${stepCounter} berhasil disimpan!*\n`;
            reply += `📝 _"${truncateText(currentStepText, 40)}"_ | ${typeLabels[currentStepType]} | ${isRequired ? 'Wajib' : 'Opsional'}\n\n`;
            reply += `📊 _Progress: ${stepsCreated}/${totalSteps} pertanyaan_\n\n`;
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += `📝 *Pertanyaan #${nextStep} dari ${totalSteps}*\n`;
            reply += 'Ketik teks pertanyaan berikutnya.\n\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n🛑 _Ketik /cancel untuk membatalkan_';
            await sock.sendMessage(jid, { text: reply });
        } else {
            // Semua step sudah dibuat → selesai
            const { flowKeyword } = session.data;

            let reply = '🎉 *MENU LAYANAN BERHASIL DIBUAT!*\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += `📋 *Menu:* ${flowTitle}\n`;
            reply += `🔑 *Keyword:* \`${flowKeyword}\`\n`;
            reply += `📝 *Jumlah Pertanyaan:* ${stepsCreated}\n`;
            reply += `📌 *Tipe:* Pengecekan (Warga Input)\n\n`;
            reply += '━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += '_Menu sudah aktif dan siap digunakan!_\n';
            reply += '_Ketik /setting untuk mengedit teks pesan._\n';
            reply += '_Ketik /buildmenu untuk membuat menu baru lainnya._';
            await sock.sendMessage(jid, { text: reply });
            endAdminSession(jid);
        }
        return true;
    }


    // Safety net: jika session aktif tapi tidak ada step yang cocok,
    // TETAP return true agar tidak jatuh ke wargaController ("gangguan")
    if (session) {
        console.warn(`[ADMIN_CTRL] Session aktif tapi step "${session.step}" tidak tertangani. JID: ${jid}`);
        return true;
    }

    return false;
};

// ═══════════════════════════════════════════════════════
//  STATS COMMAND HANDLER
// ═══════════════════════════════════════════════════════

const handleStatsCommand = async (sock, msg, jid) => {
    try {
        await sock.sendMessage(jid, { text: '⏳ _Mengambil data statistik tiket. Mohon tunggu..._' });

        const token = await getAdminToken();
        if (!token) {
            await sock.sendMessage(jid, { text: '❌ Sesi admin Anda tidak valid atau token tidak ditemukan.' });
            return;
        }
        const headers = { Authorization: `Bearer ${token}` };

        const [openRes, progressRes, resolvedRes] = await Promise.all([
            nestClient.get('/tickets', { params: { status: 'OPEN', limit: 1 }, headers }),
            nestClient.get('/tickets', { params: { status: 'IN_PROGRESS', limit: 1 }, headers }),
            nestClient.get('/tickets', { params: { status: 'RESOLVED', limit: 1 }, headers })
        ]);

        const openCount = openRes.data?.meta?.total || openRes.data?.data?.length || 0;
        const progressCount = progressRes.data?.meta?.total || progressRes.data?.data?.length || 0;
        const resolvedCount = resolvedRes.data?.meta?.total || resolvedRes.data?.data?.length || 0;
        const totalCount = openCount + progressCount + resolvedCount;

        const statsMsg = `📊 *Ringkasan Kinerja Layanan Kota*
-------------------------
Berikut adalah status penanganan laporan masyarakat saat ini:

📥 Total Laporan Aktif: ${totalCount}
🆕 Menunggu Respons (OPEN): ${openCount}
🚧 Sedang Dikerjakan (IN_PROGRESS): ${progressCount}
✅ Selesai (RESOLVED): ${resolvedCount}

Terus pantau dan pastikan tidak ada laporan yang terbengkalai.`;

        await sock.sendMessage(jid, { text: statsMsg });
    } catch (error) {
        console.error('[ADMIN_CTRL] Error fetching stats:', error?.message);
        await sock.sendMessage(jid, { text: '❌ Terjadi kesalahan saat mengambil statistik tiket.' });
    }
};

module.exports = { handleAdminMessage, handleStatsCommand };
