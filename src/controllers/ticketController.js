'use strict';

const { getTickets, getTicketById, updateTicketStatus, getStaffList, assignTicket, getAdminUserId } = require('../services/ticketService');
const {
    startAdminSession,
    getAdminSession,
    updateAdminSession,
    endAdminSession,
} = require('../services/adminSessionService');

const PID = `[PID:${process.pid}]`;

// ══════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════

const STATUS_MAP = {
    1: 'IN_PROGRESS',
    2: 'RESOLVED',
    3: 'REJECTED',
};

const STATUS_LABEL = {
    OPEN: 'Terbuka (OPEN)',
    IN_PROGRESS: 'Sedang Dikerjakan (IN_PROGRESS)',
    RESOLVED: 'Selesai (RESOLVED)',
    REJECTED: 'Ditolak (REJECTED)',
};

const TICKET_STATUS_CHOICE_MAP = {
    '1': 'OPEN',
    '2': 'IN_PROGRESS',
    '3': 'RESOLVED',
    '4': 'REJECTED',
};

const TICKET_STATUS_MENU =
    'Menu Pencarian Tiket\n' +
    '-------------------------\n' +
    'Pilih status tiket yang ingin ditampilkan:\n\n' +
    '1. OPEN (Baru Masuk)\n' +
    '2. IN_PROGRESS (Sedang Dikerjakan)\n' +
    '3. RESOLVED (Selesai)\n' +
    '4. REJECTED (Ditolak)\n\n' +
    '-------------------------\n' +
    'Balas dengan angka pilihan (1-4).\n' +
    'Ketik /cancel untuk membatalkan.';

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════

const unwrap = (res) => res?.data?.data ?? res?.data ?? res;

const formatToJid = (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : null;
};

const humanizeKey = (key) => {
    // Remove 'ask_<category>_' prefix pattern, then replace underscores with spaces
    let clean = key.replace(/^ask_[a-z0-9]+_/i, '').replace(/_/g, ' ');
    return clean.charAt(0).toUpperCase() + clean.slice(1);
};

const parseDescription = (raw) => {
    if (!raw) return '-';
    try {
        const parsed = JSON.parse(raw);
        const lines = Object.entries(parsed)
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => `  - ${humanizeKey(k)}: ${v}`);
        return lines.length > 0 ? lines.join('\n') : raw;
    } catch {
        return raw;
    }
};

const shortPreview = (raw) => {
    if (!raw) return 'Tidak ada keterangan';
    let text = '';
    try {
        const parsed = JSON.parse(raw);
        text = Object.values(parsed).filter(Boolean).join('; ');
    } catch {
        text = raw;
    }
    return text.length > 60 ? text.substring(0, 60) + '...' : text;
};

const formatTicketDetail = (ticket) => {
    const id = ticket.ticketNumber || ticket.id || '-';
    const kat = ticket.category?.name || ticket.category?.title || 'Layanan Publik';
    const desc = parseDescription(ticket.description);
    const alamat = ticket.address || ticket.alamat || ticket.location || '-';
    const pelapor = ticket.user?.name || ticket.reporterName || ticket.warga?.name || '-';
    const statusRaw = ticket.status || 'OPEN';
    const statusLabel = STATUS_LABEL[statusRaw] || statusRaw;

    return (
        'Detail Informasi Tiket\n' +
        '-------------------------\n' +
        `Nomor Tiket  : ${id}\n` +
        `Kategori     : ${kat}\n` +
        `Pelapor      : ${pelapor}\n` +
        `Alamat       : ${alamat}\n` +
        `Status       : ${statusLabel}\n` +
        `Deskripsi    :\n${desc}\n` +
        '-------------------------\n\n' +
        'Pilih tindakan:\n' +
        '1. Ubah Status\n' +
        '2. Lempar Tugas (Assign)\n' +
        '0. Batal'
    );
};

const buildTicketList = (tickets, statusLabel) => {
    let reply = `Daftar Tiket - Status: ${statusLabel}\n-------------------------\n\n`;
    tickets.forEach((t, idx) => {
        const num = t.ticketNumber || t.id || '-';
        const kat = t.category?.name || t.category?.title || 'Layanan Publik';
        const preview = shortPreview(t.description);
        reply += `${idx + 1}. [${num}] ${kat}\n   ${preview}\n\n`;
    });
    reply += '-------------------------\n';
    reply += 'Balas dengan nomor urut tiket untuk melihat detail.\n';
    reply += 'Ketik /cancel untuk membatalkan.';
    return reply;
};

// ══════════════════════════════════════════════════════════
//  COMMAND ENTRY POINT
// ══════════════════════════════════════════════════════════

const handleTicketCommand = async (sock, msg, jid, text) => {
    console.log(`${PID} [TICKET] handleTicketCommand | jid=${jid}`);

    const existing = getAdminSession(jid);
    if (existing) endAdminSession(jid);

    startAdminSession(jid);
    updateAdminSession(jid, {
        step: 'SELECT_TICKET_STATUS',
        type: 'TICKET_FLOW',
        data: {},
    });

    await sock.sendMessage(jid, { text: TICKET_STATUS_MENU });
};

// ══════════════════════════════════════════════════════════
//  SESSION STATE MACHINE
// ══════════════════════════════════════════════════════════

const handleTicketSession = async (sock, msg, jid, text, session) => {
    if (!session) {
        console.error(`${PID} [TICKET] handleTicketSession called without session | jid=${jid}`);
        return;
    }
    console.log(`${PID} [TICKET] step=${session.step} | jid=${jid}`);

    // ── SELECT_TICKET_STATUS ──────────────────────────────
    if (session.step === 'SELECT_TICKET_STATUS') {
        const selectedStatus = TICKET_STATUS_CHOICE_MAP[text];
        if (!selectedStatus) {
            await sock.sendMessage(jid, { text: 'Pilihan tidak valid. Silakan balas dengan angka 1 hingga 4.' });
            return;
        }

        await sock.sendMessage(jid, { text: 'Sistem sedang mengambil data tiket. Mohon tunggu sebentar.' });

        let tickets;
        try {
            const raw = await getTickets({ status: selectedStatus, limit: 10 });
            if (Array.isArray(raw)) tickets = raw;
            else if (Array.isArray(raw?.data)) tickets = raw.data;
            else tickets = [];
        } catch (err) {
            console.error(`${PID} [TICKET] getTickets error:`, err?.message);
            await sock.sendMessage(jid, { text: 'Terjadi kesalahan saat mengambil data dari server. Silakan coba kembali.' });
            endAdminSession(jid);
            return;
        }

        if (!tickets.length) {
            await sock.sendMessage(jid, { text: `Tidak ditemukan tiket dengan status ${selectedStatus}.` });
            endAdminSession(jid);
            return;
        }

        const ticketMap = {};
        tickets.forEach((t, idx) => { ticketMap[idx + 1] = t.id; });

        updateAdminSession(jid, {
            step: 'WAITING_TICKET_CHOICE',
            data: { ticketMap, requestedStatus: selectedStatus },
        });

        console.log(`${PID} [TICKET] Step -> WAITING_TICKET_CHOICE | status=${selectedStatus} | count=${tickets.length}`);
        await sock.sendMessage(jid, { text: buildTicketList(tickets, STATUS_LABEL[selectedStatus] || selectedStatus) });
        return;
    }

    // ── WAITING_TICKET_CHOICE ─────────────────────────────
    if (session.step === 'WAITING_TICKET_CHOICE') {
        const { ticketMap } = session.data;
        const choice = parseInt(text);

        if (isNaN(choice) || !ticketMap[choice]) {
            await sock.sendMessage(jid, { text: 'Nomor tidak valid. Silakan pilih sesuai daftar tiket di atas.' });
            return;
        }

        const ticketId = ticketMap[choice];
        await sock.sendMessage(jid, { text: 'Memuat detail tiket. Mohon tunggu.' });

        let ticket;
        try {
            const raw = await getTicketById(ticketId);
            ticket = unwrap(raw);
        } catch (err) {
            console.error(`${PID} [TICKET] getTicketById error:`, err?.message);
            await sock.sendMessage(jid, { text: 'Terjadi kesalahan saat memuat detail tiket. Silakan coba kembali.' });
            return;
        }

        updateAdminSession(jid, {
            step: 'WAITING_TICKET_ACTION',
            data: { ...session.data, ticketId, ticket },
        });

        await sock.sendMessage(jid, { text: formatTicketDetail(ticket) });
        return;
    }

    // ── WAITING_TICKET_ACTION ─────────────────────────────
    if (session.step === 'WAITING_TICKET_ACTION') {
        if (text === '0') {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Tindakan dibatalkan.' });
            return;
        }

        if (text === '1') {
            updateAdminSession(jid, { step: 'WAITING_STATUS_CHOICE' });
            const reply =
                'Ubah Status Tiket\n' +
                '-------------------------\n' +
                'Pilih status baru:\n\n' +
                '1. IN_PROGRESS (Sedang Dikerjakan)\n' +
                '2. RESOLVED (Selesai)\n' +
                '3. REJECTED (Ditolak)\n' +
                '0. Batal\n\n' +
                'Balas dengan angka pilihan.';
            await sock.sendMessage(jid, { text: reply });
            return;
        }

        if (text === '2') {
            await sock.sendMessage(jid, { text: 'Sistem sedang mengambil daftar petugas. Mohon tunggu.' });

            let staffList;
            try {
                const raw = await getStaffList();
                staffList = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
            } catch (err) {
                console.error(`${PID} [TICKET] getStaffList error:`, err?.message);
                await sock.sendMessage(jid, { text: 'Terjadi kesalahan saat mengambil daftar petugas. Silakan coba kembali.' });
                return;
            }

            if (!staffList.length) {
                await sock.sendMessage(jid, { text: 'Tidak ada petugas yang tersedia untuk ditugaskan.' });
                return;
            }

            const staffMap = {};
            let reply = 'Daftar Petugas Tersedia\n-------------------------\n\n';
            staffList.forEach((s, idx) => {
                const name = s.name || s.fullName || 'Petugas';
                const unit = s.unit || s.dinas || s.department || '';
                const phone = s.phone || s.phoneNumber || s.whatsapp || null;
                staffMap[idx + 1] = { id: s.id, name, phone };
                reply += `${idx + 1}. ${name}${unit ? ` (${unit})` : ''}\n`;
            });
            reply += '\n-------------------------\n0. Batal\n\nBalas dengan nomor urut petugas.';

            updateAdminSession(jid, {
                step: 'WAITING_ASSIGN_CHOICE',
                data: { ...session.data, staffMap },
            });

            console.log(`${PID} [TICKET] Step -> WAITING_ASSIGN_CHOICE | staffCount=${staffList.length}`);
            await sock.sendMessage(jid, { text: reply });
            return;
        }

        await sock.sendMessage(jid, {
            text: 'Pilihan tidak valid.\n\n1. Ubah Status\n2. Lempar Tugas\n0. Batal',
        });
        return;
    }

    // ── WAITING_STATUS_CHOICE ─────────────────────────────
    if (session.step === 'WAITING_STATUS_CHOICE') {
        if (text === '0') {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Tindakan dibatalkan.' });
            return;
        }

        const newStatus = STATUS_MAP[parseInt(text)];
        if (!newStatus) {
            await sock.sendMessage(jid, { text: 'Pilihan tidak valid. Balas dengan angka 1, 2, 3, atau 0 untuk batal.' });
            return;
        }

        const { ticketId } = session.data;
        await sock.sendMessage(jid, { text: 'Memproses perubahan status. Mohon tunggu.' });

        try {
            await updateTicketStatus(ticketId, newStatus);
        } catch (err) {
            console.error(`${PID} [TICKET] updateTicketStatus error:`, err?.message);
            await sock.sendMessage(jid, {
                text:
                    'Gagal memperbarui status tiket. Server sedang tidak dapat diakses.\n\n' +
                    'Silakan coba kembali:\n1. IN_PROGRESS\n2. RESOLVED\n3. REJECTED\n0. Batal',
            });
            return;
        }

        endAdminSession(jid);
        const statusLabel = STATUS_LABEL[newStatus] || newStatus;
        console.log(`${PID} [TICKET] Status updated | ticketId=${ticketId} | status=${newStatus}`);
        await sock.sendMessage(jid, {
            text: `Status tiket berhasil diperbarui menjadi: ${statusLabel}.`,
        });
        return;
    }

    // ── WAITING_ASSIGN_CHOICE ───────────────────────────────
    if (session.step === 'WAITING_ASSIGN_CHOICE') {
        if (text === '0') {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Penugasan dibatalkan. Tiket belum ditetapkan ke petugas manapun.' });
            return;
        }

        // Guard: ensure session data is intact
        const staffMap = session.data?.staffMap;
        const ticketId = session.data?.ticketId;
        const ticket = session.data?.ticket;

        if (!staffMap) {
            console.error(`${PID} [TICKET] WAITING_ASSIGN_CHOICE: staffMap missing from session.data`, session.data);
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Terjadi kesalahan sesi. Silakan mulai ulang perintah /tiket.' });
            return;
        }

        const choice = parseInt(text);
        const chosen = staffMap[choice];

        if (!chosen) {
            await sock.sendMessage(jid, { text: `Nomor tidak valid. Pilih angka 1 s.d. ${Object.keys(staffMap).length}, atau balas 0 untuk batal.` });
            return;
        }

        await sock.sendMessage(jid, { text: `Memproses penugasan kepada ${chosen.name}. Mohon tunggu.` });

        try {
            // Resolve assignedBy from the cached admin JWT
            const assignedBy = await getAdminUserId();
            if (!assignedBy) {
                console.warn(`${PID} [TICKET] Could not resolve assignedBy from JWT`);
            }

            await assignTicket(ticketId, chosen.id, assignedBy);
            console.log(`${PID} [TICKET] Assignment API success | ticketId=${ticketId} | assignedTo=${chosen.id} | assignedBy=${assignedBy}`);
        } catch (err) {
            console.error(`${PID} [TICKET] assignTicket error:`, err?.response?.data || err?.message);
            await sock.sendMessage(jid, {
                text:
                    'Gagal melakukan penugasan melalui sistem.\n\n' +
                    `Keterangan: ${err?.response?.data?.message || err?.message || 'Server tidak merespons'}\n\n` +
                    'Silakan coba kembali atau hubungi administrator.',
            });
            return; // Keep session alive for retry
        }

        // Send WhatsApp notification to assigned staff (best-effort)
        const staffJid = formatToJid(chosen.phone);
        const ticketNum = ticket?.ticketNumber || ticketId;
        const kategori = ticket?.category?.name || ticket?.category?.title || 'Layanan Publik';
        const previewText = shortPreview(ticket?.description);

        if (staffJid) {
            const notifText =
                'Pemberitahuan Tugas Baru\n' +
                '-------------------------\n' +
                `Kepada Yth. ${chosen.name},\n\n` +
                'Anda ditugaskan untuk menindaklanjuti laporan masyarakat berikut:\n\n' +
                `Nomor Tiket  : ${ticketNum}\n` +
                `Kategori     : ${kategori}\n` +
                `Keterangan   : ${previewText}\n\n` +
                '-------------------------\n' +
                'Mohon segera ditindaklanjuti sesuai prosedur yang berlaku.\n' +
                'Terima kasih atas dedikasi Anda.';
            try {
                await sock.sendMessage(staffJid, { text: notifText });
                console.log(`${PID} [TICKET] Notif sent | jid=${staffJid}`);
            } catch (notifErr) {
                console.error(`${PID} [TICKET] Notif failed:`, notifErr?.message);
            }
        } else {
            console.warn(`${PID} [TICKET] No phone for staff, skip notif | staffId=${chosen.id}`);
        }

        endAdminSession(jid);
        await sock.sendMessage(jid, {
            text:
                `Penugasan berhasil dicatat dalam sistem.\n\n` +
                `Tiket nomor ${ticketNum} telah ditetapkan kepada ${chosen.name}.\n` +
                (staffJid
                    ? 'Notifikasi WhatsApp telah dikirimkan kepada petugas yang bersangkutan.'
                    : 'Catatan: Nomor WhatsApp petugas tidak tersedia. Notifikasi tidak dapat dikirim.'),
        });
        return;
    }

    // Fallthrough guard
    console.warn(`${PID} [TICKET] Unknown step: ${session.step} | jid=${jid}`);
};

module.exports = { handleTicketCommand, handleTicketSession };
