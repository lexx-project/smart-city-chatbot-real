const { isAdminJid } = require('../services/adminService');
const { getCmsMessages, updateCmsMessage } = require('../services/botFlowService');
const { startAdminSession, getAdminSession, updateAdminSession, endAdminSession } = require('../services/adminSessionService');

// ═══════════════════════════════════════════════════════
//  KONFIGURASI KATEGORI & LABEL
// ═══════════════════════════════════════════════════════

/**
 * Definisi kategori pesan.
 * Setiap kategori memiliki label emoji dan fungsi matcher
 * yang menentukan apakah sebuah pesan masuk ke kategori tersebut.
 */
const MESSAGE_CATEGORIES = [
    {
        id: 'greeting',
        label: '👋 Pesan Sambutan & Sesi',
        match: (msg) => {
            const k = (msg.messageKey || '').toLowerCase();
            const t = (msg.messageType || '').toLowerCase();
            return ['greeting', 'success', 'timeout'].some(
                (kw) => k.includes(kw) || t.includes(kw)
            );
        },
    },
    {
        id: 'error',
        label: '⚠️ Pesan Error & Validasi',
        match: (msg) => {
            const k = (msg.messageKey || '').toLowerCase();
            const t = (msg.messageType || '').toLowerCase();
            return ['error', 'invalid_choice', 'session_expired'].some(
                (kw) => k.includes(kw) || t.includes(kw)
            );
        },
    },
    {
        id: 'menu',
        label: '📋 Menu & Kategori',
        match: (msg) => {
            const k = (msg.messageKey || '').toLowerCase();
            const t = (msg.messageType || '').toLowerCase();
            return ['category_prompt', 'sub_category_prompt', 'no_categories'].some(
                (kw) => k.includes(kw) || t.includes(kw)
            );
        },
    },
    {
        id: 'flow',
        label: '📝 Alur Layanan (Flow)',
        match: (msg) => {
            const k = (msg.messageKey || '').toLowerCase();
            return k.startsWith('flow_');
        },
    },
    {
        id: 'notification',
        label: '🔔 Notifikasi Sistem',
        match: (msg) => {
            const k = (msg.messageKey || '').toLowerCase();
            const t = (msg.messageType || '').toLowerCase();
            return ['ticket_status_update', 'confirmation_prompt'].some(
                (kw) => k.includes(kw) || t.includes(kw)
            );
        },
    },
];

// Kategori fallback untuk pesan yang tidak masuk kategori mana pun
const FALLBACK_CATEGORY = { id: 'other', label: '📦 Lainnya' };

// ═══════════════════════════════════════════════════════
//  LABEL YANG MANUSIAWI (Human-Readable)
// ═══════════════════════════════════════════════════════

/**
 * Lookup table untuk mengonversi keyword dalam messageKey
 * menjadi label yang mudah dibaca.
 */
const KEY_LABEL_MAP = {
    // Greeting & Session
    greeting: '👋 Pesan Sapaan',
    welcome: '🏠 Pesan Selamat Datang',
    success: '✅ Pesan Berhasil',
    timeout: '⏰ Pesan Waktu Habis',

    // Error & Validation
    error: '❌ Pesan Error',
    invalid_choice: '🚫 Pilihan Tidak Valid',
    session_expired: '⏳ Sesi Kedaluwarsa',

    // Menu & Category
    category_prompt: '📂 Prompt Pilih Kategori',
    sub_category_prompt: '📁 Prompt Sub-Kategori',
    no_categories: '📭 Tidak Ada Kategori',

    // Flow-specific keywords
    ask_lokasi: '📍 Pertanyaan Lokasi',
    ask_deskripsi: '📝 Pertanyaan Deskripsi',
    ask_foto: '📸 Pertanyaan Foto',
    ask_nama: '👤 Pertanyaan Nama',
    ask_kontak: '📞 Pertanyaan Kontak',
    ask_alamat: '🏡 Pertanyaan Alamat',
    ask_tanggal: '📅 Pertanyaan Tanggal',
    ask_waktu: '🕐 Pertanyaan Waktu',
    ask_jumlah: '🔢 Pertanyaan Jumlah',
    confirm: '✔️ Konfirmasi',
    result: '📊 Hasil',
    intro: '📌 Pengantar',

    // Notification
    ticket_status_update: '🔔 Update Status Tiket',
    confirmation_prompt: '❓ Prompt Konfirmasi',

    // Flow domain keywords (untuk parenthetical context)
    jalan: 'Jalan Rusak',
    lampu: 'Lampu Jalan',
    sampah: 'Sampah',
    banjir: 'Banjir',
    air: 'Air PDAM',
    pdam: 'PDAM',
    pohon: 'Pohon Tumbang',
    parkir: 'Parkir Liar',
    kebisingan: 'Kebisingan',
    perizinan: 'Perizinan',
    kependudukan: 'Kependudukan',
    administrasi: 'Administrasi',
};

/**
 * Label emoji untuk setiap domain flow, digunakan dalam daftar sub-grup.
 */
const FLOW_DOMAIN_LABELS = {
    jalan: '🛣️ Jalan Rusak',
    lampu: '💡 Lampu Jalan',
    sampah: '🗑️ Sampah',
    banjir: '🌊 Banjir',
    air: '💧 Air PDAM',
    pdam: '💧 PDAM',
    pohon: '🌳 Pohon Tumbang',
    parkir: '🚗 Parkir Liar',
    kebisingan: '🔊 Kebisingan',
    perizinan: '📄 Perizinan',
    kependudukan: '👥 Kependudukan',
    administrasi: '🏛️ Administrasi',
};

/**
 * Mengonversi messageKey mentah menjadi label yang mudah dibaca manusia.
 * Contoh: "flow_jalan_ask_lokasi" -> "📍 Pertanyaan Lokasi (Jalan Rusak)"
 */
const humanizeKey = (messageKey) => {
    if (!messageKey) return 'Pesan Tanpa Nama';

    const key = messageKey.toLowerCase();

    // Untuk key yang diawali flow_, parse secara khusus
    if (key.startsWith('flow_')) {
        const parts = key.replace('flow_', '').split('_');

        // Cari label aksi (ask_lokasi, confirm, result, dll.)
        let actionLabel = '';
        let domainLabel = '';

        // Coba match multi-word action dulu (mis: ask_lokasi)
        for (let i = 0; i < parts.length; i++) {
            for (let j = parts.length; j > i; j--) {
                const candidate = parts.slice(i, j).join('_');
                if (KEY_LABEL_MAP[candidate]) {
                    actionLabel = KEY_LABEL_MAP[candidate];
                    // Sisa parts sebelum aksi = domain
                    const domainParts = parts.slice(0, i);
                    domainLabel = domainParts
                        .map((p) => KEY_LABEL_MAP[p] || titleCase(p))
                        .filter(Boolean)
                        .join(' ');
                    break;
                }
            }
            if (actionLabel) break;
        }

        if (actionLabel) {
            return domainLabel
                ? `${actionLabel} (${domainLabel})`
                : actionLabel;
        }

        // Fallback: title-case semua parts
        return parts.map((p) => titleCase(p)).join(' ');
    }

    // Untuk key non-flow, cek langsung di lookup
    if (KEY_LABEL_MAP[key]) return KEY_LABEL_MAP[key];

    // Coba match parsial
    for (const [kw, lbl] of Object.entries(KEY_LABEL_MAP)) {
        if (key.includes(kw)) return lbl;
    }

    // Fallback: ubah underscore menjadi spasi dan title-case
    return titleCase(messageKey.replace(/_/g, ' '));
};

/** Utility: Title Case */
const titleCase = (str) =>
    String(str || '')
        .split(' ')
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''))
        .join(' ');

// ═══════════════════════════════════════════════════════
//  UTILITAS
// ═══════════════════════════════════════════════════════

/**
 * Mengelompokkan array pesan ke dalam kategori.
 * Mengembalikan array { category, messages } yang hanya berisi
 * kategori dengan >= 1 pesan.
 */
const groupMessagesByCategory = (messages) => {
    const assigned = new Set();
    const groups = [];

    for (const cat of MESSAGE_CATEGORIES) {
        const matched = messages.filter((m, idx) => {
            if (assigned.has(idx)) return false;
            if (cat.match(m)) {
                assigned.add(idx);
                return true;
            }
            return false;
        });

        if (matched.length > 0) {
            groups.push({ category: cat, messages: matched });
        }
    }

    // Pesan yang tidak masuk kategori mana pun
    const unmatched = messages.filter((_, idx) => !assigned.has(idx));
    if (unmatched.length > 0) {
        groups.push({ category: FALLBACK_CATEGORY, messages: unmatched });
    }

    return groups;
};

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

/**
 * Mengelompokkan pesan-pesan flow berdasarkan domain.
 * Contoh: flow_jalan_ask_lokasi -> domain "jalan"
 * Mengembalikan array { domain, label, messages }
 */
const groupFlowByDomain = (flowMessages) => {
    const domainMap = {};

    for (const msg of flowMessages) {
        const key = (msg.messageKey || '').toLowerCase();
        // Ambil kata pertama setelah "flow_" sebagai domain
        const afterFlow = key.replace(/^flow_/, '');
        const domainKey = afterFlow.split('_')[0] || 'lainnya';

        if (!domainMap[domainKey]) {
            domainMap[domainKey] = [];
        }
        domainMap[domainKey].push(msg);
    }

    return Object.entries(domainMap).map(([domain, messages]) => ({
        domain,
        label: FLOW_DOMAIN_LABELS[domain] || `📝 ${titleCase(domain)}`,
        messages,
    }));
};

// ═══════════════════════════════════════════════════════
//  HANDLER UTAMA
// ═══════════════════════════════════════════════════════

const handleAdminMessage = async (sock, msg, bodyText = '') => {
    const jid = msg?.key?.remoteJid;
    const pushName = msg.pushName || 'Admin';
    if (!jid) return false;

    const text = String(bodyText || '').trim();

    const isAdmin = await isAdminJid(sock, jid, pushName);
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
        await sock.sendMessage(jid, { text: '⏳ _Mengambil daftar pesan dari server..._' });

        let messages;
        try {
            messages = await getCmsMessages();
        } catch (err) {
            console.error('[ADMIN_CTRL] getCmsMessages error:', err?.message);
            messages = null;
        }

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            await sock.sendMessage(jid, {
                text:
                    '❌ *GAGAL MEMUAT DATA*\n\n' +
                    'Tidak dapat mengambil daftar pesan dari backend.\n\n' +
                    '*Kemungkinan penyebab:*\n' +
                    '• Server NestJS belum berjalan\n' +
                    '• Koneksi ke backend (nestClient) terputus\n' +
                    '• Kredensial admin di .env tidak valid\n\n' +
                    '💡 _Cek log terminal bot untuk detail error._',
            });
            return true;
        }

        session = startAdminSession(jid);
        const groups = groupMessagesByCategory(messages);

        session.data.messagesList = messages;
        session.data.groups = groups;

        let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
        reply += '📍 _Menu Utama_\n';
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += 'Pilih kategori pesan yang ingin dikelola:\n\n';

        groups.forEach((g, idx) => {
            reply += `*${idx + 1}.* ${g.category.label} _(${g.messages.length} pesan)_\n`;
        });

        reply += '\n━━━━━━━━━━━━━━━━━━━━━\n';
        reply += '👉 _Balas dengan angka (contoh: 1)_\n';
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

        // Khusus kategori Flow: tampilkan sub-grup domain dulu
        if (selectedGroup.category.id === 'flow') {
            const flowDomains = groupFlowByDomain(selectedGroup.messages);

            updateAdminSession(jid, {
                step: 'SELECT_FLOW_DOMAIN',
                data: {
                    ...session.data,
                    selectedCategory: selectedGroup,
                    categoryIndex: choice,
                    flowDomains,
                },
            });

            let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
            reply += `📍 _Menu Utama > ${selectedGroup.category.label}_\n`;
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += 'Pilih jenis layanan yang ingin dikelola:\n\n';

            flowDomains.forEach((fd, idx) => {
                reply += `*${idx + 1}.* ${fd.label} _(${fd.messages.length} pesan)_\n`;
            });

            reply += '\n━━━━━━━━━━━━━━━━━━━━━\n';
            reply += '*0.* ⬅️ Kembali ke daftar kategori\n';
            reply += '👉 _Balas dengan angka layanan (contoh: 1)_\n';
            reply += '🛑 _Ketik /cancel untuk membatalkan_';

            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        // Kategori non-flow: langsung tampilkan daftar pesan
        updateAdminSession(jid, {
            step: 'SELECT_MESSAGE',
            data: {
                ...session.data,
                selectedCategory: selectedGroup,
                categoryIndex: choice,
            },
        });

        let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
        reply += `📍 _Menu Utama > ${selectedGroup.category.label}_\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `Pesan dalam kategori *${selectedGroup.category.label}*:\n\n`;

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
    //  STEP 1b: SELECT_FLOW_DOMAIN (khusus kategori Flow)
    // ────────────────────────────────────────────────────
    if (session.step === 'SELECT_FLOW_DOMAIN') {
        const { flowDomains, selectedCategory } = session.data;

        // Opsi kembali ke daftar kategori
        if (text === '0') {
            updateAdminSession(jid, {
                step: 'SELECT_CATEGORY',
                data: {
                    ...session.data,
                    selectedCategory: undefined,
                    categoryIndex: undefined,
                    flowDomains: undefined,
                },
            });

            const groups = session.data.groups;
            let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
            reply += '📍 _Menu Utama_\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += 'Pilih kategori pesan yang ingin dikelola:\n\n';

            groups.forEach((g, idx) => {
                reply += `*${idx + 1}.* ${g.category.label} _(${g.messages.length} pesan)_\n`;
            });

            reply += '\n━━━━━━━━━━━━━━━━━━━━━\n';
            reply += '👉 _Balas dengan angka (contoh: 1)_\n';
            reply += '🛑 _Ketik /cancel untuk membatalkan_';

            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        const choice = parseInt(text);

        if (isNaN(choice) || choice < 1 || choice > flowDomains.length) {
            await sock.sendMessage(jid, {
                text: '❌ Pilihan tidak valid. Balas dengan angka layanan yang tertera, atau *0* untuk kembali.',
            });
            return true;
        }

        const selectedDomain = flowDomains[choice - 1];

        // Override selectedCategory.messages dengan pesan domain terpilih
        updateAdminSession(jid, {
            step: 'SELECT_MESSAGE',
            data: {
                ...session.data,
                selectedDomain,
                // Simpan referensi pesan yang tampil (hanya milik domain ini)
                selectedCategory: {
                    ...selectedCategory,
                    messages: selectedDomain.messages,
                },
            },
        });

        let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
        reply += `📍 _Menu Utama > ${selectedCategory.category.label} > ${selectedDomain.label}_\n`;
        reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
        reply += `Pesan dalam *${selectedDomain.label}*:\n\n`;

        selectedDomain.messages.forEach((m, idx) => {
            const label = humanizeKey(m.messageKey);
            const preview = truncateText(m.messageText, 50);
            reply += `*${idx + 1}.* ${label}\n`;
            reply += `   💬 _"${preview}"_\n\n`;
        });

        reply += '━━━━━━━━━━━━━━━━━━━━━\n';
        reply += '*0.* ⬅️ Kembali ke daftar layanan\n';
        reply += '👉 _Balas dengan angka pesan yang ingin diubah_\n';
        reply += '🛑 _Ketik /cancel untuk membatalkan_';

        await sock.sendMessage(jid, { text: reply });
        return true;
    }

    // ────────────────────────────────────────────────────
    //  STEP 2: SELECT_MESSAGE (dalam kategori)
    // ────────────────────────────────────────────────────
    if (session.step === 'SELECT_MESSAGE') {
        const selectedCategory = session.data.selectedCategory;
        const selectedDomain = session.data.selectedDomain; // ada jika dari flow

        // Opsi kembali
        if (text === '0') {
            // Jika berasal dari flow domain, kembali ke daftar domain
            if (selectedDomain) {
                const { flowDomains } = session.data;
                // Kembalikan selectedCategory ke bentuk asli (semua flow messages)
                const originalFlowGroup = session.data.groups.find(
                    (g) => g.category.id === 'flow'
                );

                updateAdminSession(jid, {
                    step: 'SELECT_FLOW_DOMAIN',
                    data: {
                        ...session.data,
                        selectedCategory: originalFlowGroup,
                        selectedDomain: undefined,
                    },
                });

                let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
                reply += `📍 _Menu Utama > ${originalFlowGroup.category.label}_\n`;
                reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
                reply += 'Pilih jenis layanan yang ingin dikelola:\n\n';

                flowDomains.forEach((fd, idx) => {
                    reply += `*${idx + 1}.* ${fd.label} _(${fd.messages.length} pesan)_\n`;
                });

                reply += '\n━━━━━━━━━━━━━━━━━━━━━\n';
                reply += '*0.* ⬅️ Kembali ke daftar kategori\n';
                reply += '👉 _Balas dengan angka layanan (contoh: 1)_\n';
                reply += '🛑 _Ketik /cancel untuk membatalkan_';

                await sock.sendMessage(jid, { text: reply });
                return true;
            }

            // Kategori non-flow: kembali ke daftar kategori
            updateAdminSession(jid, {
                step: 'SELECT_CATEGORY',
                data: {
                    ...session.data,
                    selectedCategory: undefined,
                    categoryIndex: undefined,
                },
            });

            const groups = session.data.groups;
            let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
            reply += '📍 _Menu Utama_\n';
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += 'Pilih kategori pesan yang ingin dikelola:\n\n';

            groups.forEach((g, idx) => {
                reply += `*${idx + 1}.* ${g.category.label} _(${g.messages.length} pesan)_\n`;
            });

            reply += '\n━━━━━━━━━━━━━━━━━━━━━\n';
            reply += '👉 _Balas dengan angka (contoh: 1)_\n';
            reply += '🛑 _Ketik /cancel untuk membatalkan_';

            await sock.sendMessage(jid, { text: reply });
            return true;
        }

        const choice = parseInt(text);
        const categoryMessages = selectedCategory.messages;

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
        const domainBreadcrumb = selectedDomain ? ` > ${selectedDomain.label}` : '';
        let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
        reply += `📍 _Menu Utama > ${selectedCategory.category.label}${domainBreadcrumb} > ${label}_\n`;
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
        const { selectedMsg, selectedCategory, selectedDomain, placeholders } = session.data;
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
        const domainBreadcrumb = selectedDomain ? ` > ${selectedDomain.label}` : '';
        let reply = '⚙️ *PENGATURAN TEKS BOT*\n';
        reply += `📍 _Menu Utama > ${selectedCategory.category.label}${domainBreadcrumb} > ${label} > Preview_\n`;
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
            // Kembali ke SELECT_MESSAGE dalam kategori/domain yang sama
            const { selectedCategory, selectedDomain } = session.data;

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

            const domainBreadcrumb = selectedDomain ? ` > ${selectedDomain.label}` : '';
            const listTitle = selectedDomain ? selectedDomain.label : selectedCategory.category.label;
            const backLabel = selectedDomain ? 'daftar layanan' : 'daftar kategori';

            let reply = '↩️ _Perubahan dibatalkan._\n\n';
            reply += '⚙️ *PENGATURAN TEKS BOT*\n';
            reply += `📍 _Menu Utama > ${selectedCategory.category.label}${domainBreadcrumb}_\n`;
            reply += '━━━━━━━━━━━━━━━━━━━━━\n\n';
            reply += `Pesan dalam *${listTitle}*:\n\n`;

            selectedCategory.messages.forEach((m, idx) => {
                const label = humanizeKey(m.messageKey);
                const preview = truncateText(m.messageText, 50);
                reply += `*${idx + 1}.* ${label}\n`;
                reply += `   💬 _"${preview}"_\n\n`;
            });

            reply += '━━━━━━━━━━━━━━━━━━━━━\n';
            reply += `*0.* ⬅️ Kembali ke ${backLabel}\n`;
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

    return false;
};

module.exports = { handleAdminMessage };
