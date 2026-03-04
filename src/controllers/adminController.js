const { isAdminJid } = require('../services/adminService');
const { getCmsMessages, updateCmsMessage, createCmsFlow, createCmsStep } = require('../services/botFlowService');
const { startAdminSession, getAdminSession, updateAdminSession, endAdminSession, getAuthenticatedStaff } = require('../services/adminSessionService');
const { nestClient } = require('../api/nestClient');
const { getAdminToken } = require('../services/adminAuthService');


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

    const authStaff = getAuthenticatedStaff(jid);
    const isSuperOrAdmin = authStaff && ['ADMIN', 'SUPER_ADMIN'].includes(authStaff.role?.toUpperCase());

    // Check old admin routing or new staff auth routing
    const isAdmin = await isAdminJid(sock, jid, pushName);
    if (!isAdmin && !isSuperOrAdmin) return false;

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
