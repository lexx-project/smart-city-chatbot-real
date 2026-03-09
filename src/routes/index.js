const { handleAdminMessage, handleStatsCommand } = require('../controllers/adminController');
const { handleWargaMessage } = require('../controllers/wargaController');
const { handleTicketCommand, handleTicketSession } = require('../controllers/ticketController');
const { handleCekTugasCommand, handleCekTugasSession } = require('../controllers/tugasController');
const { handleTugaskuCommand, handleTugaskuSession } = require('../controllers/dinasController');
const { logIncomingChat } = require('../utils/logger');
const { extractBodyText, shouldSkipMessage, isStaleMessage } = require('../middlewares/messageMiddleware');
const { getAdminSession } = require('../services/adminSessionService');

// SENJATA AUTO-DETECT
const { resolvePhoneFromLid } = require('../services/lidService');
const { getStaffData } = require('../services/botFlowService');

const processedMessageIds = new Set();

const registerRoutes = (sock) => {
    sock.ev.on('messages.upsert', async ({ type, messages }) => {
        if (type !== 'notify') return;
        if (!Array.isArray(messages) || messages.length === 0) return;

        for (const msg of messages) {
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

                // ── 1. RESOLVE NOMOR HP (LID TO REAL PHONE) ──
                const local = jid.split('@')[0];
                let phone = local;
                if (jid.endsWith('@lid')) {
                    const resolved = await resolvePhoneFromLid(local);
                    if (resolved) phone = resolved;
                }

                // ── 2. AUTO-DETECT ADMIN / STAFF (Tanpa /login) ──
                const staffData = await getStaffData(phone);

                const isAdmin = staffData && staffData.roleNameString && staffData.roleNameString.includes('ADMIN');
                const isSuperOrAdmin = isAdmin;
                const isStaff = staffData && staffData.roleNameString;

                // ── TICKET COMMAND (/tiket) ──
                if ((isAdmin || isSuperOrAdmin) && (bodyText === '/tiket' || bodyText.toLowerCase().startsWith('/tiket '))) {
                    console.log(`[PID:${process.pid}] [ROUTER] /tiket command from admin ${phone}`);
                    await handleTicketCommand(sock, msg, jid, bodyText);
                    handledByAdmin = true;
                    continue;
                }

                // ── CEKTUGAS COMMAND (/cektugas) ──
                if ((isAdmin || isSuperOrAdmin) && bodyText.toLowerCase().startsWith('/cektugas')) {
                    console.log(`[PID:${process.pid}] [ROUTER] /cektugas command from admin ${phone}`);
                    await handleCekTugasCommand(sock, msg, jid);
                    handledByAdmin = true;
                    continue;
                }

                // ── STATS COMMAND (/stats) ──
                if ((isAdmin || isSuperOrAdmin) && bodyText.toLowerCase().startsWith('/stats')) {
                    console.log(`[PID:${process.pid}] [ROUTER] /stats command from admin ${phone}`);
                    handledByAdmin = true;
                    continue;
                }

                // ── TUGASKU COMMAND (/tugasku) ── 
                if (isStaff && bodyText.toLowerCase().startsWith('/tugasku')) {
                    console.log(`[PID:${process.pid}] [ROUTER] /tugasku command | jid=${jid}`);
                    // Lempar staffData ke dinasController
                    await handleTugaskuCommand(sock, msg, jid, staffData);
                    handledByAdmin = true;
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
                const ticketSession = anySession;
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
                handledByAdmin = await handleAdminMessage(sock, msg, bodyText, staffData);
                if (handledByAdmin) continue;

                // ── ADMIN SESSION GUARD ──
                const adminSession = getAdminSession(jid);
                if (adminSession) {
                    console.log(`[ROUTER] Admin ${jid} punya sesi aktif (step: ${adminSession.step}), skip wargaController`);
                    continue;
                }

                if (!bodyText) continue;
                logIncomingChat(msg, 'WARGA');

                // ── WARGA FLOW ──
                await handleWargaMessage(sock, msg, bodyText, staffData);

            } catch (error) {
                console.error('[ROUTER_MESSAGE_ERROR]', error);
                if (handledByAdmin) continue;
            }
        }
    });
};

module.exports = {
    registerRoutes,
};