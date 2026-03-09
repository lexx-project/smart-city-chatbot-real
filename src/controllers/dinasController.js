'use strict';

const fs = require('fs');
const path = require('path');

/**
 * dinasController.js
 * and notify the admin of status updates.
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const { nestClient } = require('../api/nestClient');
const { getAdminToken } = require('../services/adminAuthService');

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
const { getStaffData } = require('../services/botFlowService');

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

const notifyAdmins = async (sock, payload) => {
    try {
        console.log("[NOTIF_ADMIN] Mencari daftar admin untuk pengiriman notifikasi...");

        // Ambil token dan tembak langsung ke endpoint staff pake nestClient
        const token = await getAdminToken();
        const res = await nestClient.get('/staff', {
            params: { limit: 100 },
            headers: { Authorization: `Bearer ${token}` }
        });

        const list = res.data?.data || res.data || [];

        // Filter semua staff yang memiliki role ADMIN atau SUPER_ADMIN
        const admins = list.filter(u => {
            const roleName = typeof u.role === 'string' ? u.role : (u.role?.name || '');
            return roleName.toUpperCase().includes('ADMIN') && u.phone;
        });

        if (admins.length === 0) {
            console.warn("[NOTIF_ADMIN] Tidak ditemukan user dengan role ADMIN di database.");
            return;
        }

        for (const admin of admins) {
            // Pastikan format JID benar
            const jid = admin.phone.includes('@s.whatsapp.net')
                ? admin.phone
                : `${admin.phone.replace(/\D/g, '')}@s.whatsapp.net`;

            await sock.sendMessage(jid, payload);
            console.log(`[NOTIF_ADMIN] Notif terkirim ke ${admin.fullName} (${jid})`);
        }
    } catch (err) {
        console.error("[NOTIF_ADMIN_ERROR] Gagal mengirim notifikasi ke admin:", err.message);
    }
};

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
    try {
        const parsed = JSON.parse(raw);
        // Filter: Hanya ambil teks bermakna (bukan angka pilihan/lampiran)
        const meaningfulTexts = Object.values(parsed).filter(val => {
            if (!val) return false;
            const strVal = String(val).trim();
            if (strVal.length <= 2) return false; // Abaikan angka pilihan
            if (strVal.includes('[LAMPIRAN FOTO]')) return false; // Sembunyikan nama file
            return true;
        });

        if (meaningfulTexts.length === 0) return 'Ada lampiran foto / pilihan';

        const text = meaningfulTexts.join(' | ');
        return text.length > 50 ? text.substring(0, 50) + '...' : text;
    } catch {
        return raw.length > 50 ? raw.substring(0, 50) + '...' : raw;
    }
};

// ══════════════════════════════════════════════════════════
//  COMMAND ENTRY POINT
// ══════════════════════════════════════════════════════════

const handleTugaskuCommand = async (sock, msg, jid, staffData = null) => {
    console.log(`${PID} [DINAS] handleTugaskuCommand | jid=${jid}`);

    const existing = getAdminSession(jid);
    if (existing) endAdminSession(jid);

    await sock.sendMessage(jid, { text: 'Sistem sedang memverifikasi identitas Anda. Mohon tunggu sebentar.' });

    if (!staffData || !staffData.id) {
        console.log(`[DINAS_DEBUG] Akses ditolak. JID: ${jid} bukan staff terdaftar.`);
        await sock.sendMessage(jid, { text: 'Akses ditolak. Nomor Anda tidak terdaftar sebagai petugas.' });
        return;
    }

    const me = staffData; // me.id dan me.name otomatis terisi dari BE

    console.log(`[DINAS_DEBUG] VERIFICATION SUCCESS! Name: ${me.name || me.fullName}, ID: ${me.id}, Role: ${me.roleNameString || me.role}`);

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
        const pelapor = t.user?.fullName || t.user?.name || 'Warga';
        const preview = shortPreview(t.description);
        const status = STATUS_LABEL[t.status] || t.status;

        reply += `*${idx + 1}. [${num}] ${kat}*\n👤 Pelapor: ${pelapor}\n📌 Status: ${status}\n📝 _${preview}_\n\n`;
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

            const notifContent = { text: notifAdmin };
            await notifyAdmins(sock, notifContent);
        } catch (notifErr) {
            console.error(`${PID} [DINAS] Admin notify failed:`, notifErr?.message);
            // Best-effort — don't abort
        }

        try {
            const citizenPhone = ticket.user?.phoneNumber || ticket.user?.phone;
            if (citizenPhone && newStatus === 'IN_PROGRESS') {
                const citizenJid = citizenPhone.includes('@s.whatsapp.net') ? citizenPhone : `${citizenPhone.replace(/\D/g, '')}@s.whatsapp.net`;
                const notifWarga =
                    `📢 *UPDATE LAPORAN ANDA*\n` +
                    `-------------------------\n` +
                    `Halo ${ticket.user?.fullName || 'Warga'},\n\n` +
                    `Laporan Anda dengan nomor tiket *${ticketNumber}* (${kat}) saat ini *SEDANG DIKERJAKAN* oleh petugas kami di lapangan (${staffName}).\n\n` +
                    `Kami akan memberikan kabar selanjutnya setelah penanganan selesai. Terima kasih.`;

                await sock.sendMessage(citizenJid, { text: notifWarga });
                console.log(`[NOTIF_WARGA] Sent IN_PROGRESS to ${citizenJid}`);
            }
        } catch (err) { console.error("Gagal notif warga:", err.message); }
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
                const notifContent = { image: buffer, caption: adminMsg };
                await notifyAdmins(sock, notifContent);
            } catch (notifErr) {
                console.error(`${PID} [DINAS] Admin notify failed:`, notifErr?.message);
            }

            try {
                const kat = ticket.category?.name || ticket.category?.title || 'Layanan Publik';
                const citizenPhone = ticket.user?.phoneNumber || ticket.user?.phone;
                if (citizenPhone) {
                    const citizenJid = citizenPhone.includes('@s.whatsapp.net') ? citizenPhone : `${citizenPhone.replace(/\D/g, '')}@s.whatsapp.net`;
                    const notifWarga =
                        `✅ *LAPORAN SELESAI*\n` +
                        `-------------------------\n` +
                        `Halo ${ticket.user?.fullName || 'Warga'},\n\n` +
                        `Laporan Anda dengan nomor tiket *${ticketNumber}* (${kat}) telah *SELESAI DITANGANI* oleh tim kami.\n\n` +
                        `Berikut adalah foto bukti penanganan dari lokasi. Terima kasih atas partisipasi Anda membangun kota!`;

                    await sock.sendMessage(citizenJid, { image: buffer, caption: notifWarga });
                    console.log(`[NOTIF_WARGA] Sent RESOLVED with image to ${citizenJid}`);
                }
            } catch (err) { console.error("Gagal notif warga:", err.message); }
        } catch (err) {
            console.error(`${PID} [DINAS] Evidence upload error:`, err?.response?.data || err?.message);
            await sock.sendMessage(jid, { text: 'Terjadi kesalahan saat memproses bukti foto. Silakan coba kembali.' });
        }
        return;
    }

    console.warn(`${PID} [DINAS] Unknown step: ${session.step} | jid=${jid}`);
};

module.exports = { handleTugaskuCommand, handleTugaskuSession };
