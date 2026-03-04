'use strict';

/**
 * tugasController.js
 * Handles the /cektugas command for admin workload monitoring.
 * Allows viewing tickets assigned to a specific staff member, filtered by status.
 */

const { getStaffList, getTickets } = require('../services/ticketService');
const {
    startAdminSession,
    getAdminSession,
    updateAdminSession,
    endAdminSession,
} = require('../services/adminSessionService');

const PID = `[PID:${process.pid}]`;

const WORKLOAD_STATUS_MAP = {
    '1': ['OPEN', 'IN_PROGRESS'],
    '2': ['RESOLVED'],
};

const WORKLOAD_STATUS_LABEL = {
    '1': 'Sedang Berjalan (OPEN / IN_PROGRESS)',
    '2': 'Selesai (RESOLVED)',
};

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════

const humanizeKey = (key) => {
    let clean = key.replace(/^ask_[a-z0-9]+_/i, '').replace(/_/g, ' ');
    return clean.charAt(0).toUpperCase() + clean.slice(1);
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

// ══════════════════════════════════════════════════════════
//  COMMAND ENTRY POINT
// ══════════════════════════════════════════════════════════

const handleCekTugasCommand = async (sock, msg, jid) => {
    console.log(`${PID} [CEK_TUGAS] handleCekTugasCommand | jid=${jid}`);

    const existing = getAdminSession(jid);
    if (existing) endAdminSession(jid);

    await sock.sendMessage(jid, { text: 'Sistem sedang mengambil daftar petugas. Mohon tunggu sebentar.' });

    let staffList;
    try {
        const raw = await getStaffList();
        staffList = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
    } catch (err) {
        console.error(`${PID} [CEK_TUGAS] getStaffList error:`, err?.message);
        await sock.sendMessage(jid, { text: 'Terjadi kesalahan saat mengambil daftar petugas. Silakan coba kembali.' });
        return;
    }

    if (!staffList.length) {
        await sock.sendMessage(jid, { text: 'Tidak ada data petugas yang ditemukan dalam sistem.' });
        return;
    }

    const staffMap = {};
    let reply = 'Daftar Petugas / Dinas\n-------------------------\n\n';
    staffList.forEach((s, idx) => {
        const name = s.name || s.fullName || 'Petugas';
        const unit = s.unit || s.dinas || s.department || '';
        staffMap[idx + 1] = {
            id: s.id,
            name,
            unit,
            phone: s.phone || s.phoneNumber || s.whatsapp || null,
        };
        reply += `${idx + 1}. ${name}${unit ? ` (${unit})` : ''}\n`;
    });
    reply += '\n-------------------------\n0. Batal\n\nBalas dengan nomor urut petugas yang ingin diperiksa bebannya.';

    startAdminSession(jid);
    updateAdminSession(jid, {
        step: 'SELECT_STAFF_TO_CHECK',
        type: 'CEK_TUGAS_FLOW',
        data: { staffMap },
    });

    console.log(`${PID} [CEK_TUGAS] Session started | step=SELECT_STAFF_TO_CHECK | staffCount=${staffList.length}`);
    await sock.sendMessage(jid, { text: reply });
};

// ══════════════════════════════════════════════════════════
//  SESSION STATE MACHINE
// ══════════════════════════════════════════════════════════

const handleCekTugasSession = async (sock, msg, jid, text, session) => {
    if (!session) {
        console.error(`${PID} [CEK_TUGAS] called without session | jid=${jid}`);
        return;
    }
    console.log(`${PID} [CEK_TUGAS] step=${session.step} | jid=${jid}`);

    // ── SELECT_STAFF_TO_CHECK ─────────────────────────────
    if (session.step === 'SELECT_STAFF_TO_CHECK') {
        if (text === '0') {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Pemeriksaan beban kerja dibatalkan.' });
            return;
        }

        const { staffMap } = session.data;
        const choice = parseInt(text);
        const chosen = staffMap[choice];

        if (!chosen) {
            await sock.sendMessage(jid, { text: 'Nomor tidak valid. Silakan pilih sesuai daftar, atau balas 0 untuk batal.' });
            return;
        }

        updateAdminSession(jid, {
            step: 'SELECT_WORKLOAD_STATUS',
            data: { ...session.data, selectedStaff: chosen },
        });

        const reply =
            `Petugas Terpilih: ${chosen.name}${chosen.unit ? ` (${chosen.unit})` : ''}\n` +
            '-------------------------\n\n' +
            'Pilih kategori pekerjaan yang ingin dilihat:\n\n' +
            '1. Sedang Berjalan (OPEN / IN_PROGRESS)\n' +
            '2. Selesai (RESOLVED)\n' +
            '0. Batal';

        await sock.sendMessage(jid, { text: reply });
        return;
    }

    // ── SELECT_WORKLOAD_STATUS ────────────────────────────
    if (session.step === 'SELECT_WORKLOAD_STATUS') {
        if (text === '0') {
            endAdminSession(jid);
            await sock.sendMessage(jid, { text: 'Pemeriksaan beban kerja dibatalkan.' });
            return;
        }

        const statusGroup = WORKLOAD_STATUS_MAP[text];
        if (!statusGroup) {
            await sock.sendMessage(jid, { text: 'Pilihan tidak valid. Balas 1, 2, atau 0 untuk batal.' });
            return;
        }

        const { selectedStaff } = session.data;
        await sock.sendMessage(jid, { text: `Mengambil data pekerjaan untuk ${selectedStaff.name}. Mohon tunggu.` });

        // Fetch ALL tickets from backend (no params) — filter entirely in memory
        let allTickets = [];
        try {
            const apiRes = await getTickets({ limit: 200 });
            allTickets = Array.isArray(apiRes) ? apiRes
                : Array.isArray(apiRes?.data?.data) ? apiRes.data.data
                    : Array.isArray(apiRes?.data) ? apiRes.data
                        : [];
        } catch (err) {
            console.error(`${PID} [CEK_TUGAS] getTickets error:`, err?.message);
            await sock.sendMessage(jid, { text: 'Terjadi kesalahan saat mengambil data tiket. Silakan coba kembali.' });
            endAdminSession(jid);
            return;
        }

        console.log(`[CEK_TUGAS DEBUG] Total tiket dari BE: ${allTickets.length}`);
        if (allTickets.length > 0) {
            console.log('[CEK_TUGAS DEBUG] Sample tiket:', JSON.stringify(allTickets[0], null, 2));
        }

        const staffId = selectedStaff.id;
        const isOngoing = text === '1';

        const staffTickets = allTickets.filter(t => {
            // Check assignments array (NestJS response shape from backend debug)
            const staffMatch =
                t.assignments?.some(a => a.assignedTo === selectedStaff.id && a.isActive === true) || false;

            // Match status group
            const statusMatch = isOngoing
                ? ['OPEN', 'IN_PROGRESS', 'ASSIGNED'].includes(t.status)
                : t.status === 'RESOLVED';

            return staffMatch && statusMatch;
        });

        const statusLabel = WORKLOAD_STATUS_LABEL[text];

        if (!staffTickets.length) {
            endAdminSession(jid);
            await sock.sendMessage(jid, {
                text:
                    `Daftar Pekerjaan - ${selectedStaff.name}\n` +
                    `Status        : ${statusLabel}\n` +
                    '-------------------------\n\n' +
                    'Tidak ada tiket yang ditemukan untuk petugas ini.\n\n' +
                    'Ketik /cektugas untuk memulai ulang.',
            });
            return;
        }

        let reply = `Daftar Pekerjaan - ${selectedStaff.name}\n`;
        reply += `Status        : ${statusLabel}\n`;
        reply += '-------------------------\n\n';

        staffTickets.forEach((t, idx) => {
            const num = t.ticketNumber || t.id || '-';
            const kat = t.category?.name || t.category?.title || 'Layanan Publik';
            const desc = formatDesc(t.description);
            reply += `${idx + 1}. [${num}] ${kat}\n${desc}\n\n`;
        });

        reply += `-------------------------\nTotal: ${staffTickets.length} tiket.\nKetik /cancel untuk selesai.`;

        endAdminSession(jid);
        console.log(`${PID} [CEK_TUGAS] Result | staff=${selectedStaff.name} | total=${allTickets.length} | matched=${staffTickets.length}`);
        await sock.sendMessage(jid, { text: reply });
        return;
    }

    console.warn(`${PID} [CEK_TUGAS] Unknown step: ${session.step} | jid=${jid}`);
};

module.exports = { handleCekTugasCommand, handleCekTugasSession };
