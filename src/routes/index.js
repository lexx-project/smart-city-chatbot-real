const { handleAdminMessage, handleStatsCommand } = require('../controllers/adminController');
const { handleWargaMessage } = require('../controllers/wargaController');
const { handleTicketCommand, handleTicketSession } = require('../controllers/ticketController');
const { handleCekTugasCommand, handleCekTugasSession } = require('../controllers/tugasController');
const { handleTugaskuCommand, handleTugaskuSession } = require('../controllers/dinasController');
const { logIncomingChat } = require('../utils/logger');
const { extractBodyText, shouldSkipMessage, isStaleMessage } = require('../middlewares/messageMiddleware');
const { checkIsAdmin } = require('../services/adminService');
const { getAdminSession, loginStaffWa, getAuthenticatedStaff } = require('../services/adminSessionService');


// ═══════════════════════════════════════════════════════
//  GLOBAL MESSAGE LOCKING — Mencegah double-processing
//  dari Baileys race condition / duplicate event trigger
// ═══════════════════════════════════════════════════════
const processedMessageIds = new Set();

const registerRoutes = (sock) => {
    sock.ev.on('messages.upsert', async ({ type, messages }) => {
        if (type !== 'notify') return;
        if (!Array.isArray(messages) || messages.length === 0) return;

        for (const msg of messages) {
            // ── GLOBAL DEDUP: Cek & lock message ID ──
            const msgId = msg?.key?.id;
            if (msgId) {
                if (processedMessageIds.has(msgId)) continue;
                processedMessageIds.add(msgId);
                setTimeout(() => processedMessageIds.delete(msgId), 5_000);
            }


            let handledByAdmin = false;

            try {
                if (shouldSkipMessage(msg)) continue;

                const jid = msg.key.remoteJid;
                if (!jid) continue;

                if (isStaleMessage(msg, 120)) {
                    console.log(`[ANTI-SPAM] Membuang pesan basi dari: ${jid}`);
                    continue;
                }

                const bodyText = extractBodyText(msg);
                msg.bodyText = bodyText;

                // 1. Handle Login Command
                if (bodyText.startsWith('/login ')) {
                    const parts = bodyText.split(' ');
                    if (parts.length < 3) {
                        await sock.sendMessage(jid, { text: '❌ Format: /login <email> <password>' });
                        continue;
                    }
                    await sock.sendMessage(jid, { text: '⏳ Memverifikasi kredensial ke server...' });
                    const res = await loginStaffWa(jid, parts[1], parts[2]);
                    if (res.success) {
                        await sock.sendMessage(jid, { text: `✅ Berhasil! Selamat datang ${res.name} (${res.role}).` });
                    } else {
                        await sock.sendMessage(jid, { text: `❌ Login Gagal: ${res.message}` });
                    }
                    continue;
                }

                // 2. Identify Admin Status from Session
                const staff = getAuthenticatedStaff(jid);
                const isAdmin = staff && staff.role.includes('ADMIN');
                const isSuperOrAdmin = isAdmin;

                // ── TICKET COMMAND (/tiket or /tiket <status>) ──
                // Must run BEFORE handleAdminMessage so the ticket session
                // is never intercepted by adminController.
                if ((isAdmin || isSuperOrAdmin) && (bodyText === '/tiket' || bodyText.toLowerCase().startsWith('/tiket '))) {
                    console.log(`[PID:${process.pid}] [ROUTER] /tiket command from admin ${jid}`);
                    await handleTicketCommand(sock, msg, jid, bodyText);
                    handledByAdmin = true;
                    continue;
                }

                // ── CEKTUGAS COMMAND (/cektugas) ──
                if ((isAdmin || isSuperOrAdmin) && bodyText.toLowerCase().startsWith('/cektugas')) {
                    console.log(`[PID:${process.pid}] [ROUTER] /cektugas command from admin ${jid}`);
                    await handleCekTugasCommand(sock, msg, jid);
                    handledByAdmin = true;
                    continue;
                }

                // ── STATS COMMAND (/stats) ──
                if ((isAdmin || isSuperOrAdmin) && bodyText.toLowerCase().startsWith('/stats')) {
                    console.log(`[PID:${process.pid}] [ROUTER] /stats command from admin ${jid}`);
                    await handleStatsCommand(sock, msg, jid);
                    handledByAdmin = true;
                    continue;
                }

                // ── TUGASKU COMMAND (/tugasku) ── Dinas/Staff only, no admin check
                if (bodyText.toLowerCase().startsWith('/tugasku')) {
                    console.log(`[PID:${process.pid}] [ROUTER] /tugasku command | jid=${jid}`);
                    await handleTugaskuCommand(sock, msg, jid);
                    handledByAdmin = true; // prevent fall-through to warga
                    continue;
                }

                // ── DINAS SESSION REPLIES (DINAS_FLOW) ──
                const anySession = getAdminSession(jid);
                if (anySession?.type === 'DINAS_FLOW') {
                    console.log(`[PID:${process.pid}] [ROUTER] Dinas session | jid=${jid} | step=${anySession.step}`);
                    await handleTugaskuSession(sock, msg, jid, bodyText, anySession);
                    handledByAdmin = true;
                    continue;
                }

                // ── TICKET SESSION REPLIES (TICKET_FLOW) ──
                // Check step prefix so this catches WAITING_TICKET_* and WAITING_STATUS_* states.
                const ticketSession = anySession; // reuse — already fetched above
                if ((isAdmin || isSuperOrAdmin) && ticketSession && (
                    ticketSession.step === 'SELECT_TICKET_STATUS' ||
                    ticketSession.step.startsWith('WAITING_TICKET_') ||
                    ticketSession.step.startsWith('WAITING_STATUS_') ||
                    ticketSession.step === 'WAITING_ASSIGN_CHOICE' ||
                    ticketSession.type === 'TICKET_FLOW'
                )) {
                    console.log(`[PID:${process.pid}] [ROUTER] Ticket session reply | jid=${jid} | step=${ticketSession.step}`);
                    await handleTicketSession(sock, msg, jid, bodyText, ticketSession);
                    handledByAdmin = true;
                    continue;
                }

                // ── CEKTUGAS SESSION REPLIES (CEK_TUGAS_FLOW) ──
                if ((isAdmin || isSuperOrAdmin) && ticketSession?.type === 'CEK_TUGAS_FLOW') {
                    console.log(`[PID:${process.pid}] [ROUTER] CekTugas session | jid=${jid} | step=${ticketSession.step}`);
                    await handleCekTugasSession(sock, msg, jid, bodyText, ticketSession);
                    handledByAdmin = true;
                    continue;
                }

                // ── ADMIN FLOW (CMS, buildmenu, etc.) ──
                handledByAdmin = await handleAdminMessage(sock, msg, bodyText);
                if (handledByAdmin) continue;

                // ── ADMIN SESSION GUARD ──
                // Jika admin punya sesi aktif (CMS, buildmenu, dll.), JANGAN teruskan ke wargaController
                const adminSession = getAdminSession(jid);
                if (adminSession) {
                    console.log(`[ROUTER] Admin ${jid} punya sesi aktif (step: ${adminSession.step}), skip wargaController`);
                    continue;
                }

                if (!bodyText) continue;
                logIncomingChat(msg, 'WARGA');

                await handleWargaMessage(sock, msg, bodyText);

            } catch (error) {
                console.error('[ROUTER_MESSAGE_ERROR]', error);
                // Jika error terjadi di flow admin, JANGAN trigger apapun
                if (handledByAdmin) continue;
            }
        }
    });
};

module.exports = {
    registerRoutes,
};
