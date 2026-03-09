'use strict';

const fs = require('fs');
const path = require('path');

/**
 * dinasController.js
 * and notify the admin of status updates.
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const { getStaffList, getTickets, updateTicketStatus, addTicketAttachment } = require('../services/ticketService');
const {
    startAdminSession,
    getAdminSession,
    updateAdminSession,
    endAdminSession,
    getAuthenticatedStaff
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

const extractImagePath = (rawDescription) => {
    if (!rawDescription) return null;
    try {
        const parsed = JSON.parse(rawDescription);
        for (const val of Object.values(parsed)) {
            if (typeof val === 'string' && val.includes('[LAMPIRAN FOTO]')) {
                const fileName = val.split('[LAMPIRAN FOTO]')[1].trim();
                const fullPath = path.join(process.cwd(), 'uploads', fileName);
                if (fs.existsSync(fullPath)) return fullPath;
            }
        }
    } catch (e) { }
    return null;
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

    await sock.sendMessage(jid, { text: 'Sistem sedang memverifikasi identitas Anda. Mohon tunggu sebentar.' });

    const authStaff = getAuthenticatedStaff(jid);

    if (!authStaff) {
        console.log(`[DINAS_DEBUG] Akses ditolak. JID: ${jid} belum login.`);
        await sock.sendMessage(jid, { text: 'Akses ditolak. Anda belum login ke dalam sistem. Silakan ketik:\n\n/login <email> <password>' });
        return;
    }

    const me = authStaff;
    console.log(`[DINAS_DEBUG] VERIFICATION SUCCESS! Name: ${me.name}, ID: ${me.id}, Role: ${me.role}`);

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

        const imagePath = extractImagePath(ticket.description);

        if (imagePath) {
            await sock.sendMessage(jid, { image: { url: imagePath }, caption: detail });
        } else {
            await sock.sendMessage(jid, { text: detail });
        }
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

        if (newStatus === 'RESOLVED') {
            updateAdminSession(jid, {
                step: 'WAITING_RESOLUTION_EVIDENCE',
                data: session.data,
            });
            await sock.sendMessage(jid, {
                text: "📸 *Upload Bukti Penyelesaian*\n-------------------------\nMohon kirimkan FOTO bukti penyelesaian tugas ini langsung di chat ini.\n\n_Ketik /cancel untuk membatalkan._"
            });
            return;
        }

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
        const staffName = me.name || 'Petugas';
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

    // ── WAITING_RESOLUTION_EVIDENCE ───────────────────────
    if (session.step === 'WAITING_RESOLUTION_EVIDENCE') {
        if (text === '/cancel' || text === '0') {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Pengiriman bukti dibatalkan. Status tiket tidak diubah.' });
            return;
        }

        const hasImage = msg.message?.imageMessage || msg.message?.ephemeralMessage?.message?.imageMessage;
        if (!hasImage) {
            await sock.sendMessage(jid, { text: 'Mohon kirimkan dalam format FOTO (gambar). Bukti teks tidak diterima.' });
            return;
        }

        await sock.sendMessage(jid, { text: 'Mengunduh foto dan memproses pembaruan tiket. Mohon tunggu...' });

        try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });

            const { selectedTask, me } = session.data;
            const { id: ticketId, ticketNumber, ticket } = selectedTask;

            await updateTicketStatus(ticketId, 'RESOLVED');

            const staffName = me.name || 'Petugas';
            const tid = ticketNumber || ticketId || ticket?.ticketNumber || 'TKT';

            endAdminSession(jid);
            await sock.sendMessage(jid, { text: `✅ Bukti foto berhasil diterima. Tiket ${tid} telah ditandai SELESAI. Terima kasih atas kerja keras Anda!` });

            try {
                const adminMsg = `✅ *Tugas Selesai!*\n-------------------------\nPetugas: ${staffName}\nTiket: ${tid}\nStatus: RESOLVED\n\nBerikut adalah foto bukti pengerjaan dari lapangan:`;
                const adminJid = listAdminJids()[0];
                if (adminJid) {
                    await sock.sendMessage(adminJid, {
                        image: buffer,
                        caption: adminMsg
                    });
                }
                console.log(`${PID} [DINAS] Admin notified with image buffer for resolved ticket | adminJid=${listAdminJids()[0]}`);
            } catch (notifErr) {
                console.error(`${PID} [DINAS] Admin notify failed:`, notifErr?.message);
            }
        } catch (err) {
            console.error(`${PID} [DINAS] Evidence upload error:`, err?.response?.data || err?.message);
            await sock.sendMessage(jid, { text: 'Terjadi kesalahan saat memproses bukti foto. Silakan coba kembali.' });
        }
        return;
    }

    console.warn(`${PID} [DINAS] Unknown step: ${session.step} | jid=${jid}`);
};

module.exports = { handleTugaskuCommand, handleTugaskuSession };
