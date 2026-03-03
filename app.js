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

let currentSock = null;
let isStarting = false;
let reconnectTimer = null;
let apiServer = null;

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
        // Bersihkan listener lama untuk mencegah duplicate handling saat reconnect
        sock.ev.removeAllListeners('messages.upsert');
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
