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
// CCTV 2: CEK KALAU NYASAR (ERROR)
// ==========================================
nestClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const fullUrl = `${error.config?.baseURL || ""}${error.config?.url || ""}`;
    const status = error.response?.status || "Network Error";
    const msg = error.response?.data?.message || error.message;

    console.warn(
      `[API_CAUTION] HTTP ${status} di URL: ${fullUrl} | Pesan: ${msg}`,
    );
    return Promise.reject(error);
  },
);

module.exports = nestClient;
