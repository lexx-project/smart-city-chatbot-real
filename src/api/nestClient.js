require("dotenv").config(); // Wajib biar file .env kebaca
const axios = require("axios");

// Ambil URL, dan pastikan diakhiri dengan garis miring (/) biar axios gak bingung
let BASE_URL = process.env.NEST_API_BASE_URL || "http://localhost:3000/api/v1";
if (!BASE_URL.endsWith("/")) {
  BASE_URL += "/";
}

const nestClient = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

// ==========================================
// CCTV 1: CEK SEBELUM NEMBAK
// ==========================================
nestClient.interceptors.request.use((config) => {
  // Kalau endpoint diawali '/', hapus '/' nya biar gak nabrak
  if (config.url.startsWith("/")) {
    config.url = config.url.substring(1);
  }

  // Print alamat lengkapnya ke terminal
  console.log(
    `[API MENCARI JALAN] Nembak ke -> ${config.baseURL}${config.url}`,
  );

  return config;
});

// ==========================================
// CCTV 2: CEK KALAU NYASAR (ERROR) & FALLBACK 404
// ==========================================
nestClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || '';
    const fullUrl = `${error.config?.baseURL || ""}${url}`;
    const status = error.response?.status || "Network Error";

    // Check if it's a 404 for our missing CMS endpoints
    if (status === 404) {
      console.log(`[FALLBACK MODE] Menggunakan mock data untuk URL: ${fullUrl}`);

      // 1. Fallback for Bot Settings
      if (url.includes('bot-settings')) {
        return Promise.resolve({
          data: {
            GREETING_MSG: 'Halo! 👋 Selamat datang di Layanan Smart City.\nKetik apapun untuk memulai laporan.',
            SESSION_END_TEXT: 'Terima kasih atas laporan Anda.'
          }
        });
      }

      // 2. Fallback for Bot Admins
      if (url.includes('bot-admins')) {
        return Promise.resolve({
          data: ['62882009391607'] // Mock Admin WhatsApp number
        });
      }

      // 3. Fallback for Bot Flow Menu
      if (url.includes('bot-flow/menu')) {
        return Promise.resolve({
          data: {
            id: 'root_menu',
            stepKey: 'main_menu',
            messages: [{ messageText: 'Halo! 👋 Selamat datang di Layanan Publik Pintar.\n\nSilakan pilih layanan:\n1. Buat Laporan Pengaduan' }],
            children: [
              { id: 'mock-step-1', stepOrder: 1, stepKey: 'Pengaduan Masalah Kota' }
            ]
          }
        });
      }

      // 4. Fallback for Bot Flow Steps
      if (url.includes('bot-flow/step')) {
        return Promise.resolve({
          data: {
            id: 'mock-step-1',
            stepKey: 'ask_report',
            inputType: 'text',
            messages: [{ messageText: 'Silakan ketik detail pengaduan dan lokasi kejadian:' }],
            nextStepKey: null // Null means the flow ends here and creates the ticket
          }
        });
      }
    }

    const msg = error.response?.data?.message || error.message;

    console.error(
      `[API NYASAR] ❌ HTTP ${status} di URL: ${fullUrl} | Pesan: ${msg}`,
    );
    return Promise.reject(error);
  },
);

// ==========================================
// TICKET API WRAPPERS
// ==========================================

/**
 * GET /api/v1/tickets
 * @param {{ status?: string, limit?: number }} params
 */
const getTickets = async (params = {}) => {
  const response = await nestClient.get('tickets', { params });
  return response.data;
};

/**
 * GET /api/v1/tickets/:id
 * @param {string} id - UUID of the ticket
 */
const getTicketById = async (id) => {
  const response = await nestClient.get(`tickets/${id}`);
  return response.data;
};

/**
 * PATCH /api/v1/tickets/:id/status
 * @param {string} id - UUID of the ticket
 * @param {string} status - 'IN_PROGRESS' | 'RESOLVED' | 'REJECTED'
 */
const updateTicketStatus = async (id, status) => {
  const response = await nestClient.patch(`tickets/${id}/status`, { status });
  return response.data;
};

module.exports = { nestClient, getTickets, getTicketById, updateTicketStatus };
