'use strict';

/**
 * dinasController.js
 * Handles the /tugasku command for assigned staff (Dinas) to manage their tasks
 * and notify the admin of status updates.
 */

const { getStaffList, getTickets, updateTicketStatus } = require('../services/ticketService');
const {
    startAdminSession,
    getAdminSession,
    updateAdminSession,
    endAdminSession,
} = require('../services/adminSessionService');
const { listAdminJids } = require('../services/adminService');
const { resolvePhoneFromLid } = require('../services/lidService');

const PID = `[PID:${process.pid}]`;

// ══════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════

const ACTION_STATUS_MAP = {
    '1': 'IN_PROGRESS',
    '2': 'RESOLVED',
};

const STATUS_LABEL = {
    ACCEPTED: 'Diterima (ACCEPTED)',
    IN_PROGRESS: 'Sedang Dikerjakan (IN_PROGRESS)',
    RESOLVED: 'Selesai (RESOLVED)',
    OPEN: 'Terbuka (OPEN)',
    ASSIGNED: 'Ditugaskan (ASSIGNED)',
    REJECTED: 'Ditolak (REJECTED)',
};

// Statuses that count as "active tasks" (exclude done/rejected)
const ACTIVE_STATUSES = ['OPEN', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'];

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════

/**
 * Extract the exact string before '@' from a WhatsApp JID.
 * No digit stripping — preserves the full LID/phone as stored by WhatsApp.
 * e.g. "201958556201025@lid" -> "201958556201025"
 */
const jidToPhone = (jid) => String(jid || '').split('@')[0];

const humanizeKey = (key) => {
    let clean = key.replace(/^ask_[a-z0-9]+_/i, '').replace(/_/g, ' ');
    return clean.charAt(0).toUpperCase() + clean.slice(1);
};

const formatDesc = (raw) => {
    if (!raw) return '  - (tidak ada keterangan)';
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
        text = Object.values(JSON.parse(raw)).filter(Boolean).join('; ');
    } catch {
        text = raw;
    }
    return text.length > 60 ? text.substring(0, 60) + '...' : text;
};

// ══════════════════════════════════════════════════════════
//  COMMAND ENTRY POINT
// ══════════════════════════════════════════════════════════

const handleTugaskuCommand = async (sock, msg, jid) => {
    console.log(`${PID} [DINAS] handleTugaskuCommand | jid=${jid}`);

    const existing = getAdminSession(jid);
    if (existing) endAdminSession(jid);

    await sock.sendMessage(jid, { text: 'Sistem sedang memverifikasi identitas Anda. Mohon tunggu sebentar.' });

    // ── Step 1: Extract, translate, and convert phone to DB format ('08') ──
    let rawId = jid.split('@')[0];
    let realPhone = rawId;

    console.log(`[DINAS_DEBUG] 1. Incoming JID: ${jid}`);
    console.log(`[DINAS_DEBUG] 2. Raw ID extracted: ${rawId}`);

    if (jid.endsWith('@lid')) {
        const mappedPhone = await resolvePhoneFromLid(rawId);
        if (mappedPhone) {
            realPhone = mappedPhone;
            console.log(`[DINAS_DEBUG] 3. LID translated successfully to: ${realPhone}`);
        } else {
            console.log(`[DINAS_DEBUG] 3. WARNING: Could not resolve LID ${rawId} in session mapping!`);
        }
    } else {
        console.log(`[DINAS_DEBUG] 3. Not a LID, keeping realPhone as: ${realPhone}`);
    }

    // Convert '62' prefix to '0' to match backend DB format
    let dbPhoneFormat = realPhone;
    if (dbPhoneFormat.startsWith('62')) {
        dbPhoneFormat = '0' + dbPhoneFormat.substring(2);
    }
    console.log(`[DINAS_DEBUG] 4. Converted to DB format: ${dbPhoneFormat}`);

    let staffList;
    try {
        const raw = await getStaffList();
        staffList = Array.isArray(raw) ? raw
            : Array.isArray(raw?.data?.data) ? raw.data.data
                : Array.isArray(raw?.data) ? raw.data
                    : [];
    } catch (err) {
        console.error(`${PID} [DINAS] getStaffList error:`, err?.message);
        await sock.sendMessage(jid, { text: 'Terjadi kesalahan saat mengambil data petugas. Silakan coba kembali.' });
        return;
    }

    const staffPhones = staffList.map(s => s.phoneNumber || s.phone || 'NO_PHONE').join(', ');
    console.log(`[DINAS_DEBUG] 5. Staff phones from DB: ${staffPhones}`);

    // Exact match against DB format
    const me = staffList.find(s => {
        const sPhone = s.phoneNumber || s.phone || '';
        return sPhone === dbPhoneFormat;
    });

    if (me) {
        console.log(`[DINAS_DEBUG] 6. MATCH FOUND! Name: ${me.name || me.fullName}, ID: ${me.id}`);
    } else {
        console.log(`[DINAS_DEBUG] 6. NO MATCH FOUND for phone: ${dbPhoneFormat}`);
        await sock.sendMessage(jid, { text: 'Akses ditolak. Nomor Anda tidak terdaftar sebagai petugas/dinas dalam sistem.' });
        return;
    }

    // ── Step 2: Fetch all tickets and filter for this staff ─
    await sock.sendMessage(jid, { text: 'Identitas terverifikasi. Mengambil daftar tugas Anda...' });

    let allTickets;
    try {
        const apiRes = await getTickets({ limit: 200 });
        allTickets = Array.isArray(apiRes) ? apiRes
            : Array.isArray(apiRes?.data?.data) ? apiRes.data.data
                : Array.isArray(apiRes?.data) ? apiRes.data
                    : [];
    } catch (err) {
        console.error(`${PID} [DINAS] getTickets error:`, err?.message);
        await sock.sendMessage(jid, { text: 'Terjadi kesalahan saat mengambil data tiket. Silakan coba kembali.' });
        return;
    }

    const myTickets = allTickets.filter(t => {
        const assigned = t.assignments?.some(a => a.assignedTo === me.id && a.isActive === true);
        const active = ACTIVE_STATUSES.includes(t.status);
        return assigned && active;
    });

    if (!myTickets.length) {
        await sock.sendMessage(jid, {
            text: `Daftar Tugas Anda\n-------------------------\n\nTidak ada tugas aktif yang ditemukan untuk Anda saat ini.\n\nKetik /tugasku untuk memeriksa kembali.`,
        });
        return;
    }

    // Build task map and display list
    const taskMap = {};
    let reply = 'Daftar Tugas Anda\n-------------------------\nBerikut adalah laporan masyarakat yang ditugaskan kepada Anda:\n\n';
    myTickets.forEach((t, idx) => {
        taskMap[idx + 1] = { id: t.id, ticketNumber: t.ticketNumber || t.id, ticket: t };
        const num = t.ticketNumber || t.id || '-';
        const kat = t.category?.name || t.category?.title || 'Layanan Publik';
        const preview = shortPreview(t.description);
        const status = STATUS_LABEL[t.status] || t.status;
        reply += `${idx + 1}. [${num}] ${kat}\n   Status : ${status}\n   ${preview}\n\n`;
    });
    reply += '-------------------------\nBalas dengan angka urutan (contoh: 1) untuk memperbarui status tugas.\nKetik /cancel untuk membatalkan.';

    startAdminSession(jid);
    updateAdminSession(jid, {
        step: 'SELECT_MY_TASK',
        type: 'DINAS_FLOW',
        data: { taskMap, me },
    });

    console.log(`${PID} [DINAS] Session started | step=SELECT_MY_TASK | tasks=${myTickets.length}`);
    await sock.sendMessage(jid, { text: reply });
};

// ══════════════════════════════════════════════════════════
//  SESSION STATE MACHINE
// ══════════════════════════════════════════════════════════

const handleTugaskuSession = async (sock, msg, jid, text, session) => {
    if (!session) {
        console.error(`${PID} [DINAS] handleTugaskuSession called without session | jid=${jid}`);
        return;
    }
    console.log(`${PID} [DINAS] step=${session.step} | jid=${jid}`);

    // ── SELECT_MY_TASK ────────────────────────────────────
    if (session.step === 'SELECT_MY_TASK') {
        if (text === '0') {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Sesi pengelolaan tugas diakhiri.' });
            return;
        }

        const { taskMap, me } = session.data;
        const choice = parseInt(text);
        const chosen = taskMap[choice];

        if (!chosen) {
            await sock.sendMessage(jid, { text: `Nomor tidak valid. Pilih angka 1 s.d. ${Object.keys(taskMap).length}, atau balas 0 untuk keluar.` });
            return;
        }

        const { ticket, ticketNumber } = chosen;
        const kat = ticket.category?.name || ticket.category?.title || 'Layanan Publik';
        const desc = formatDesc(ticket.description);
        const alamat = ticket.address || ticket.alamat || ticket.location || '-';
        const status = STATUS_LABEL[ticket.status] || ticket.status;

        const detail =
            `Detail Tugas\n` +
            `-------------------------\n` +
            `Nomor Tiket : ${ticketNumber}\n` +
            `Kategori    : ${kat}\n` +
            `Alamat      : ${alamat}\n` +
            `Status      : ${status}\n\n` +
            `Detail Laporan:\n${desc}\n` +
            `-------------------------\n` +
            `Pilih tindakan:\n` +
            `1. Mulai Kerjakan (IN_PROGRESS)\n` +
            `2. Tandai Selesai (RESOLVED)\n` +
            `0. Batal`;

        updateAdminSession(jid, {
            step: 'ACTION_MY_TASK',
            data: { ...session.data, selectedTask: chosen },
        });

        await sock.sendMessage(jid, { text: detail });
        return;
    }

    // ── ACTION_MY_TASK ────────────────────────────────────
    if (session.step === 'ACTION_MY_TASK') {
        if (text === '0') {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Tindakan dibatalkan.' });
            return;
        }

        const newStatus = ACTION_STATUS_MAP[text];
        if (!newStatus) {
            await sock.sendMessage(jid, { text: 'Pilihan tidak valid. Balas 1, 2, atau 0 untuk batal.' });
            return;
        }

        const { selectedTask, me } = session.data;
        const { id: ticketId, ticketNumber, ticket } = selectedTask;

        await sock.sendMessage(jid, { text: 'Memproses pembaruan status. Mohon tunggu.' });

        try {
            await updateTicketStatus(ticketId, newStatus);
        } catch (err) {
            console.error(`${PID} [DINAS] updateTicketStatus error:`, err?.response?.data || err?.message);
            await sock.sendMessage(jid, {
                text:
                    'Gagal memperbarui status tiket. Server sedang tidak dapat diakses.\n\n' +
                    `Keterangan: ${err?.response?.data?.message || err?.message || 'Tidak diketahui'}\n\n` +
                    'Silakan coba kembali.',
            });
            return;
        }

        const statusLabel = STATUS_LABEL[newStatus] || newStatus;
        const staffName = me.name || me.fullName || 'Petugas';
        const kat = ticket.category?.name || ticket.category?.title || 'Layanan Publik';

        // ── Confirm to staff ──────────────────────────────
        endAdminSession(jid);
        await sock.sendMessage(jid, {
            text:
                `Pembaruan Berhasil\n` +
                `-------------------------\n` +
                `Status tiket ${ticketNumber} telah berhasil diubah menjadi ${statusLabel}.\n\n` +
                `Terima kasih atas tindak lanjutnya!`,
        });
        console.log(`${PID} [DINAS] Status updated | ticketId=${ticketId} | status=${newStatus} | staff=${staffName}`);

        // ── Notify admin ──────────────────────────────────
        try {
            const notifAdmin =
                `Pemberitahuan Pembaruan Status Tugas\n` +
                `-------------------------\n` +
                `Petugas lapangan telah memperbarui status laporan berikut:\n\n` +
                `Petugas     : ${staffName}\n` +
                `Nomor Tiket : ${ticketNumber}\n` +
                `Kategori    : ${kat}\n` +
                `Status Baru : ${statusLabel}\n\n` +
                `Mohon pantau sistem untuk perkembangan selanjutnya.`;

            const adminJid = listAdminJids()[0];
            if (adminJid) await sock.sendMessage(adminJid, { text: notifAdmin });
            console.log(`${PID} [DINAS] Admin notified | adminJid=${listAdminJids()[0]}`);
        } catch (notifErr) {
            console.error(`${PID} [DINAS] Admin notify failed:`, notifErr?.message);
            // Best-effort — don't abort
        }
        return;
    }

    console.warn(`${PID} [DINAS] Unknown step: ${session.step} | jid=${jid}`);
};

module.exports = { handleTugaskuCommand, handleTugaskuSession };
