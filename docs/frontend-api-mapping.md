# Smart City Chatbot - Frontend API & Bot Command Mapping

Dokumen ini menjelaskan hubungan antara command admin di WhatsApp bot dan endpoint REST API untuk Web Dashboard.

## 1. Base URL

- API Base: `http://localhost:2078/api`
- Swagger UI: `http://localhost:2078/api-docs`

## 2. Catatan Umum

- Semua response API memakai format umum:
  - `success: boolean`
  - `message: string` (opsional)
  - `data: object|array` (opsional)
- Saat ini endpoint belum memakai auth token. Jika dashboard akan dipakai publik/internal multi-user, wajib tambahkan auth middleware.

## 3. Mapping Command Bot <-> API

### 3.1 Command: `/menuadmin`

Fungsi bot:
- Menampilkan daftar command admin.

Padanan API:
- `GET /api/admin/commands`

Contoh response:
```json
{
  "success": true,
  "data": [
    "/menuadmin",
    "/setting",
    "/addadmin",
    "/listadmin",
    "/deladmin",
    "/totalchat",
    "/totalsesi",
    "/batal"
  ]
}
```

---

### 3.2 Command: `/listadmin`

Fungsi bot:
- Menampilkan daftar nomor admin.

Padanan API:
- `GET /api/admin/admins`

Contoh response:
```json
{
  "success": true,
  "data": {
    "superadmin": "62882009391607@s.whatsapp.net",
    "admins": [
      "6281234567890",
      "6289876543210"
    ]
  }
}
```

---

### 3.3 Command: `/addadmin 628xxxx`

Fungsi bot:
- Menambah admin baru.

Padanan API:
- `POST /api/admin/admins`

Body:
```json
{
  "phone": "6281234567890"
}
```

Contoh response:
```json
{
  "success": true,
  "message": "Admin ditambahkan.",
  "data": {
    "totalDynamicAdmins": 2
  }
}
```

---

### 3.4 Command: `/deladmin 628xxxx`

Fungsi bot:
- Menghapus admin.

Padanan API:
- `DELETE /api/admin/admins/:phone`

Contoh:
- `DELETE /api/admin/admins/6281234567890`

Contoh response:
```json
{
  "success": true,
  "message": "Admin dihapus."
}
```

---

### 3.5 Command: `/totalchat`

Fungsi bot:
- Menampilkan total chat warga berdasarkan rentang waktu (1 hari, 7 hari, 30 hari, 1 tahun).

Padanan API:
- `GET /api/admin/stats/totalchat?range=1d|7d|30d|1y`
- atau `GET /api/analytics/summary?range=...` (gabungan)

Contoh response:
```json
{
  "success": true,
  "data": {
    "metric": "totalchat",
    "range": "7d",
    "days": 7,
    "total": 124
  }
}
```

---

### 3.6 Command: `/totalsesi`

Fungsi bot:
- Menampilkan total sesi warga berdasarkan rentang waktu.

Padanan API:
- `GET /api/admin/stats/totalsesi?range=1d|7d|30d|1y`
- atau `GET /api/analytics/summary?range=...`

Contoh response:
```json
{
  "success": true,
  "data": {
    "metric": "totalsesi",
    "range": "30d",
    "days": 30,
    "total": 56
  }
}
```

---

### 3.7 Command: `/setting`

Fungsi bot:
- Membuka menu pengaturan admin.

Padanan API (overview):
- `GET /api/admin/settings`

Contoh response ringkas:
```json
{
  "success": true,
  "data": {
    "greetingMessage": "...",
    "timeoutText": "...",
    "sessionEndText": "...",
    "timeoutSeconds": 30,
    "mainMenu": [],
    "subMenuSettings": []
  }
}
```

## 4. Mapping Detail Opsi `/setting`

### Opsi 1: Ubah Pesan Penutup

Padanan API:
- `PUT /api/admin/settings/session-end-text`

Body:
```json
{
  "value": "Terima kasih sudah menghubungi layanan kami."
}
```

---

### Opsi 2: Ubah Pesan Timeout

Padanan API:
- `PUT /api/admin/settings/timeout-text`

Body:
```json
{
  "value": "Sesi berakhir karena tidak ada aktivitas."
}
```

---

### Opsi 3: Ubah Timeout Global

Padanan API:
- `PUT /api/admin/settings/timeout-seconds`

Body:
```json
{
  "value": 60
}
```

Valid range:
- `10` sampai `3600` detik.

---

### Opsi 4: Aktif/Nonaktifkan Menu

Padanan API:
- `PUT /api/admin/main-menu/:menuId/enabled`

Body:
```json
{
  "enabled": false
}
```

Catatan:
- `menuId` bisa dilihat dari `GET /api/admin/settings` atau `GET /api/cms`.

---

### Opsi 5: Ubah Urutan Menu

Padanan API:
- `PUT /api/admin/main-menu/reorder`

Body:
```json
{
  "order": ["menu_perizinan", "menu_kependudukan", "menu_pengaduan"]
}
```

Catatan:
- Semua `menuId` harus ada.
- Tidak boleh duplikat.
- Jumlah item harus sama dengan jumlah menu aktif di CMS.

---

### Opsi 6: Atur Jenis Respon SubMenu

Padanan API:
- `PUT /api/admin/submenus/:subMenuId/flow-mode`

Body:
```json
{
  "mode": "await_reply"
}
```

Nilai `mode`:
- `close`: setelah balasan info, sesi ditutup.
- `await_reply`: bot menunggu balasan warga.

---

### Opsi 7: Atur Durasi Tunggu Balasan SubMenu

Padanan API:
- `PUT /api/admin/submenus/:subMenuId/await-timeout`

Body:
```json
{
  "seconds": 180
}
```

Valid range:
- `30` sampai `3600` detik.

---

### Opsi 8: Atur Pesan Saat Balasan Diterima

Padanan API:
- `PUT /api/admin/submenus/:subMenuId/success-reply`

Body:
```json
{
  "message": "Terima kasih, data Anda sudah kami terima."
}
```

Catatan:
- Di bot, opsi 8 hanya menampilkan submenu yang mode-nya `await_reply`.

---

### Opsi 9: Ubah Foto Profil Bot

Di bot:
- Pilih opsi 9, lalu kirim foto atau ketik `hapus`.

Padanan API:
- Belum ada endpoint REST khusus upload/hapus foto profil bot di versi ini.
- Pengubahan PP saat ini tetap via WhatsApp command flow.

## 5. Endpoint Tambahan (Tidak ada command langsung)

### Health Check
- `GET /api/health`
- untuk monitoring status API.

### CMS Full Read/Write
- `GET /api/cms`
- `PUT /api/cms`
- `POST /api/cms/overwrite`

Fungsi:
- dipakai dashboard untuk edit full struktur CMS sekaligus.

### Analytics Realtime
- `GET /api/analytics/realtime`

Contoh response:
```json
{
  "success": true,
  "data": {
    "activeSessions": 3
  }
}
```

### Analytics Summary
- `GET /api/analytics/summary?range=1d|7d|30d|1y`

Contoh response:
```json
{
  "success": true,
  "data": {
    "range": "7d",
    "days": 7,
    "totalWargaChats": 124,
    "totalWargaSessions": 56,
    "activeSessions": 3
  }
}
```

### Reset Session Warga
- `DELETE /api/admin/sessions/:sessionKey`

Fungsi:
- reset paksa sesi warga aktif dari dashboard operasional.

## 6. Daftar range waktu baku

Gunakan parameter `range`:
- `1d` = 1 hari
- `7d` = 7 hari
- `30d` = 30 hari
- `1y` = 1 tahun

## 7. Rekomendasi Integrasi Frontend

- Ambil data awal dashboard:
  - `GET /api/admin/settings`
  - `GET /api/analytics/realtime`
  - `GET /api/analytics/summary?range=7d`
- Untuk editor CMS advanced, gunakan:
  - `GET /api/cms`
  - `PUT /api/cms`
- Untuk perubahan granular, gunakan endpoint admin settings (lebih aman daripada overwrite full JSON).

## 8. Error Handling Standar untuk Frontend

- `400` -> validasi input gagal
- `404` -> resource/menu/submenu/session tidak ditemukan
- `500` -> server/internal failure

Frontend disarankan tampilkan:
- `message` dari response jika ada
- fallback generic text jika `message` tidak tersedia
