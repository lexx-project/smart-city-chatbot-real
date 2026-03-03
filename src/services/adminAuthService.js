const nestClient = require('../api/nestClient');

let cachedToken = null;

const getAdminToken = async () => {
    if (cachedToken) return cachedToken;
    try {
        // Menggunakan akun admin dari .env, atau fallback ke akun default
        const email = process.env.CMS_EMAIL || 'admin@system.id';
        const password = process.env.CMS_PASSWORD || 'password123';

        const response = await nestClient.post('/auth/staff/login', { email, password });
        cachedToken = response.data?.data?.accessToken || response.data?.accessToken;

        console.log('[ADMIN_AUTH] Berhasil mendapatkan token dari Backend.');
        return cachedToken;
    } catch (error) {
        console.error('[ADMIN_LOGIN_ERROR] Gagal login ke Backend. Cek email/password di .env bot.');
        return null;
    }
};

const clearToken = () => { cachedToken = null; };

module.exports = { getAdminToken, clearToken };
