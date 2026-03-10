const P = require('pino'); // <--- INI YANG HILANG (Si P)
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./src/api/docs/swagger.json');
const qrcode = require('qrcode-terminal');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { registerRoutes } = require('./src/routes');
const apiRoutes = require('./src/api/routes');
const { AUTH_DIR } = require('./settings');
const { getTickets } = require('./src/services/ticketService');

// Label Status untuk Notifikasi
const STATUS_LABEL = {
    ACCEPTED: 'Diterima',
    IN_PROGRESS: 'Sedang Dikerjakan (IN_PROGRESS)',
    RESOLVED: 'Selesai (RESOLVED)',
    OPEN: 'Terbuka',
    ASSIGNED: 'Ditugaskan ke Petugas',
    REJECTED: 'Ditolak',
    CLOSED: 'Ditutup'
};

// Memori untuk menyimpan status terakhir tiket
const ticketStatusCache = new Map();
let isPollingStarted = false;

let currentSock = null;
let isStarting = false;
let reconnectTimer = null;
let apiServer = null;

const startTicketPolling = (sock) => {
    if (isPollingStarted) return;
    isPollingStarted = true;

    console.log('[POLLING] Mesin pemantau tiket diaktifkan (Cek tiap 1 menit)...');

    setInterval(async () => {
        if (!sock) return;
        try {
            // Ambil 50 tiket terbaru dari Backend
            const res = await getTickets({ limit: 50 });
            const tickets = res?.data || res?.data?.data || [];

            if (!Array.isArray(tickets)) return;

            for (const ticket of tickets) {
                const prevStatus = ticketStatusCache.get(ticket.id);

                // Jika tiket sudah ada di memori dan statusnya BERUBAH
                if (prevStatus && prevStatus !== ticket.status) {
                    const citizenPhone = ticket.user?.phoneNumber || ticket.user?.phone;

                    if (citizenPhone) {
                        const jid = citizenPhone.includes('@s.whatsapp.net')
                            ? citizenPhone
                            : `${citizenPhone.replace(/\D/g, '')}@s.whatsapp.net`;

                        const statusName = STATUS_LABEL[ticket.status] || ticket.status;
                        const notifMsg =
                            `📢 *UPDATE LAPORAN ANDA*\n` +
                            `-------------------------\n` +
                            `Halo ${ticket.user?.fullName || 'Warga'},\n\n` +
                            `Laporan Anda dengan nomor tiket *${ticket.ticketNumber}* saat ini berstatus: *${statusName}*.\n\n` +
                            `Terima kasih atas laporan Anda.`;

                        await sock.sendMessage(jid, { text: notifMsg });
                        console.log(`[POLLING] Notif update status (${ticket.status}) terkirim ke ${jid}`);
                    }
                }

                // Simpan atau update status terbaru ke memori
                ticketStatusCache.set(ticket.id, ticket.status);
            }
        } catch (error) {
            console.error('[POLLING ERROR] Gagal mengecek tiket:', error?.message);
        }
    }, 60 * 1000); // 60.000 ms = 1 menit
};

const startApiServer = () => {
    if (apiServer) return apiServer;

    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '5mb' }));

    app.use('/api', apiRoutes);
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

    const port = Number(process.env.PORT || process.env.API_PORT || 2078);
    apiServer = app.listen(port, () => {
        console.log(`[API] Express listening on http://localhost:${port}`);
        console.log(`[API] Swagger docs: http://localhost:${port}/api-docs`);
    });

    return apiServer;
};

const scheduleReconnect = (delayMs = 2500) => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startBot().catch((error) => {
            console.error('[WA] Reconnect failed', error);
        });
    }, delayMs);
};

const startBot = async () => {
    if (isStarting) return;
    isStarting = true;

    console.log('[SYSTEM] Memulai bot, memeriksa sesi...');
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Smart Public Service Bot', 'Chrome', '1.0.0'],
        });

        currentSock = sock;
        registerRoutes(sock);
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            if (sock !== currentSock) return;

            const { connection, lastDisconnect, qr } = update;
            console.log('[KONEKSI UPDATE]:', connection || 'Generating QR/Connecting...');

            if (qr) {
                console.log('\n=======================================');
                console.log('[QR CODE READY] SILAKAN SCAN SEKARANG:');
                console.log('=======================================\n');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'open') {
                console.log('\n[BERHASIL] Bot sudah terhubung dan siap menerima pesan!\n');

                // JALANKAN POLLING SAAT BOT READY
                startTicketPolling(currentSock);
                return;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const retryableReasons = new Set([
                    DisconnectReason.connectionClosed,
                    DisconnectReason.connectionLost,
                    DisconnectReason.timedOut,
                    DisconnectReason.restartRequired,
                    DisconnectReason.unavailableService,
                ]);
                const nonRetryableReasons = new Set([
                    DisconnectReason.loggedOut,
                    DisconnectReason.badSession,
                    DisconnectReason.multideviceMismatch,
                    DisconnectReason.connectionReplaced,
                    DisconnectReason.forbidden,
                ]);

                const shouldReconnect = retryableReasons.has(statusCode) || (!statusCode && !nonRetryableReasons.has(statusCode));
                console.log(`[KONEKSI TERPUTUS] Status Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

                currentSock = null;
                if (shouldReconnect) {
                    console.log('[SYSTEM] Menjadwalkan reconnect...');
                    scheduleReconnect(2500);
                } else {
                    if (statusCode === DisconnectReason.connectionReplaced) {
                        console.log('[SYSTEM] Session tergantikan oleh login lain (code 440). Scan ulang QR bila ingin pindah sesi ke perangkat ini.');
                    } else if (statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.multideviceMismatch) {
                        console.log('[SYSTEM] Session tidak valid. Hapus folder session lalu restart untuk scan QR ulang.');
                    } else if (statusCode === DisconnectReason.loggedOut) {
                        console.log('[SYSTEM] Logged out. Hapus folder session lalu restart untuk scan QR ulang.');
                    } else {
                        console.log('[SYSTEM] Koneksi ditutup tanpa retry otomatis. Cek status akun/session, lalu restart manual jika perlu.');
                    }
                }
            }
        });
    } finally {
        isStarting = false;
    }
};

startApiServer();
startBot().catch((error) => {
    console.error('[APP_BOOT_ERROR]', error);
    process.exit(1);
});
