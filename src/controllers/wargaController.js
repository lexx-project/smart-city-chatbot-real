const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const { unwrapMessage } = require("../middlewares/messageMiddleware");
const {
  getSession,
  startSession,
  updateSession,
  endSession,
} = require("../services/wargaSessionService");
const {
  extractPhoneDigits,
} = require("../services/adminService");
const {
  getMainMenu,
  getStep,
  getBotSettings,
  submitTicket,
  getOrCreateUser,
  getCategoryIdFromFlow,
  logMessageToBackend,
  createRemoteSession,
  endRemoteSession,
  getStaffData,
  uploadImageToBackend,
} = require("../services/botFlowService");
const { getAdminSession } = require("../services/adminSessionService");
const { resolvePhoneFromLid } = require("../services/lidService");
const { handleAdminMessage } = require("./adminController");


// Validator Engine
const validateInput = (text, inputType, rule) => {
  if (!text) return "Jawaban tidak boleh kosong.";

  if (inputType === "number") {
    if (!/^\d+$/.test(text))
      return "⚠️ Format salah. Jawaban WAJIB berupa angka penuh tanpa huruf/simbol.";
  }

  if (rule) {
    if (rule.startsWith("min:")) {
      const min = parseInt(rule.split(":")[1]);
      if (text.length < min)
        return `⚠️ Jawaban terlalu pendek. Minimal ${min} karakter.`;
    }
    if (rule.startsWith("regex:")) {
      try {
        let pattern = rule.replace("regex:", "");
        if (pattern.startsWith("/")) pattern = pattern.slice(1, -1);

        const regex = new RegExp(pattern);
        if (!regex.test(text))
          return "⚠️ Format jawaban tidak sesuai dengan ketentuan sistem.";
      } catch (e) {
        console.error("[REGEX_ERROR]", e);
      }
    }
  }
  return null;
};

const buildMenuMessage = (stepData) => {
  let text = "";
  if (stepData.messages && stepData.messages.length > 0) {
    text += stepData.messages.map((m) => m.messageText).join("\n\n") + "\n\n";
  }
  if (stepData.children && stepData.children.length > 0) {
    stepData.children.forEach((child, index) => {
      const no = child.stepOrder || index + 1;
      const label = child.stepKey
        ? child.stepKey.replace(/_/g, " ")
        : child.title;
      text += `*${no}.* ${label}\n`;
    });
    text += `\n_Ketik angka pilihan Anda._`;
  }
  return text.trim();
};

const handleWargaMessage = async (sock, msg, bodyText = "") => {
  const jid = msg?.key?.remoteJid;
  if (!jid) return false;

  // 1. EKSTRAK DATA PENGIRIM & LOGGING (Target PM: Bangun Data Contact)
  const local = jid.split('@')[0];
  let phone = local;

  // FIX: Jika ini adalah LID, terjemahkan dulu ke nomor HP
  if (jid.endsWith('@lid')) {
    const resolved = await resolvePhoneFromLid(local);
    if (resolved) {
      phone = resolved; // Sekarang dapet nomor HP asli (misal: 628xxx)
    }
  }

  const pushName = msg.pushName || "Warga";
  const normalizedText = String(bodyText || "").trim();

  console.log("==========================================");
  console.log(`[AURA_LOG] Pesan Masuk`);
  console.log(`- Nomor HP (Real) : ${phone}`);
  console.log(`- Nama WA         : ${pushName}`);
  console.log(`- Isi Pesan: ${normalizedText}`);
  console.log("==========================================");

  const staffData = await getStaffData(phone);

  // MASUKIN BARIS INI LEXX! Biar kita tau isi perut Backend lu:
  console.log("=== [DEBUG ADMIN] ===");
  console.log("Hasil pencarian nomor:", phone);
  console.log("Data dari BE:", JSON.stringify(staffData, null, 2));
  console.log("=====================");

  const isSuperOrAdmin = staffData && ['ADMIN', 'SUPER_ADMIN'].includes(staffData.roleNameString);
  const adminSettings = await getBotSettings();

  if (isSuperOrAdmin) {
    const isCommand = normalizedText.startsWith("/");
    const isAdminInSession = !!getAdminSession(jid);
    if (isCommand || isAdminInSession) {
      await handleAdminMessage(sock, msg, normalizedText, staffData);
      return true;
    }
  }

  if (!normalizedText) return;

  let session = getSession(jid);

  // KONDISI 1: SESI BARU
  if (!session) {
    // Daftar User & Buka Sesi di Backend
    const [userId, beSessionId] = await Promise.all([
      getOrCreateUser(phone, pushName),
      createRemoteSession(phone)
    ]);

    // FIX: Cegah lanjut kalau session BE gagal dibikin!
    if (!beSessionId) {
      console.error("[WARGA CONTROLLER] Gagal membuat remote session di Backend (beSessionId null/timeout).");
      if (!isSuperOrAdmin) {
        await sock.sendMessage(jid, {
          text: "⚠️ *Mohon Maaf*\nSistem kami sedang mengalami kepadatan/gangguan koneksi. Silakan sapa bot kembali dalam beberapa menit ke depan.",
        });
      } else {
        await sock.sendMessage(jid, {
          text: "⚠️ *[ADMIN WARNING]*\nGagal terhubung ke Backend (Endpoint Sessions Timeout). Cek koneksi API.",
        });
      }
      return true; // Hentikan proses, jangan lanjut kirim menu
    }

    const rawMenu = await getMainMenu();
    const mainMenu = rawMenu?.data || rawMenu;

    if (!mainMenu || !mainMenu.id) {
      console.error("[WARGA CONTROLLER] API Error: getMainMenu returned null or invalid.");
      if (!isSuperOrAdmin) {
        await sock.sendMessage(jid, {
          text: "Mohon maaf, layanan sistem sedang mengalami gangguan.",
        });
      }
      return true;
    }

    session = startSession(jid, sock, mainMenu.id);
    session.beSessionId = beSessionId; // Simpan ID Sesi dari Backend ke memori Bot
    updateSession(jid, { beSessionId }); // Pastikan tersimpan dengan benar di memori

    await logMessageToBackend(beSessionId, 'USER', 'TEXT', normalizedText);

    let msgToSend = adminSettings.GREETING_MSG
      ? `${adminSettings.GREETING_MSG}\n\n`
      : "";
    msgToSend += buildMenuMessage(mainMenu);

    await sock.sendMessage(jid, { text: msgToSend });
    await logMessageToBackend(beSessionId, 'BOT', 'TEXT', msgToSend);
    return true;
  }

  // KONDISI 2: VALIDASI INPUT & SIMPAN DATA JAWABAN
  const rawCurrent = await getStep(session.currentStepId);
  const currentStep = rawCurrent?.data || rawCurrent;

  if (!currentStep) {
    await sock.sendMessage(jid, {
      text: "Sesi tidak valid. Silakan mulai ulang.",
    });
    if (session.beSessionId) {
      await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
    }
    endSession(jid);
    return true;
  }

  const children = currentStep.children || [];
  let nextStepId = null;
  let errorMsg = null;
  let captionText = "";

  if (currentStep.id !== "root_menu" && currentStep.stepKey !== "main_menu") {
    const isSelectMode = children.length > 1;

    // FIX: Deteksi tipe report dari messageType, BUKAN dari inputType
    const isReportType = currentStep.messages?.[0]?.messageType === "report";

    if (!isSelectMode) {
      let finalAnswer = normalizedText;

      // Cek apakah pesan yang masuk adalah gambar
      const rawMsg = unwrapMessage(msg?.message || {});
      const isImage = !!rawMsg?.imageMessage;
      // Jika tidak ada caption, gunakan teks default
      captionText = rawMsg?.imageMessage?.caption?.trim() || "Tanpa Keterangan";

      // BYPASS: Jika isReportType bernilai true (Foto Opsional, bisa teks saja)
      if (isReportType) {
        if (isImage) {
          // Kondisi 1: Warga mengirimkan FOTO (dengan atau tanpa caption)
          try {
            await sock.sendMessage(jid, { text: "⏳ _Mengunggah data laporan ke server..._" });
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
            const fileName = `evidence_${Date.now()}.jpg`;

            // Upload ke BE
            const secureUrl = await uploadImageToBackend(buffer, fileName);

            if (secureUrl) {
              finalAnswer = captionText !== "Tanpa Keterangan" ? captionText : "Laporan dengan lampiran gambar";
              session.imageUrl = secureUrl; // Simpan URL untuk payload tiket
              session.lastReportDescription = finalAnswer; // Simpan deskripsi akhir
            } else {
              errorMsg = "⚠️ Gagal mengunggah gambar ke server. Silakan coba kirim ulang.";
            }
          } catch (err) {
            console.error("[DOWNLOAD/UPLOAD_ERROR]", err);
            errorMsg = "⚠️ Terjadi kesalahan saat memproses lampiran gambar.";
          }
        } else {
          // Kondisi 2: Warga HANYA mengirimkan TEKS (tanpa foto)
          if (!normalizedText) {
            errorMsg = "⚠️ Deskripsi laporan tidak boleh kosong. Silakan ketikkan detail laporan Anda.";
          } else {
            finalAnswer = normalizedText;
            session.lastReportDescription = finalAnswer; // Simpan teks sebagai deskripsi akhir
          }
        }
      } else {
        // Jika BUKAN report, jalankan validasi normal berdasarkan inputType
        errorMsg = validateInput(
          normalizedText,
          currentStep.inputType,
          currentStep.validationRule,
        );
      }

      if (errorMsg) {
        await sock.sendMessage(jid, { text: errorMsg });
        if (session && session.beSessionId) {
          await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', errorMsg);
        }
        updateSession(jid);
        return true;
      }

      // Simpan jawaban (teks normal) jika BUKAN tipe report
      if (!isReportType) {
        session.answers[currentStep.stepKey] = finalAnswer;
      }
    }

    // LOGGING CHAT KE BACKEND
    if (session && session.beSessionId && !isReportType) {
      await logMessageToBackend(session.beSessionId, 'USER', 'TEXT', normalizedText);
    } else if (session && session.beSessionId && isReportType && !errorMsg) {
      await logMessageToBackend(session.beSessionId, 'USER', 'IMAGE', `[GAMBAR DIUNGGAH] ${captionText}`);
    }
  }

  // TENTUKAN LANGKAH BERIKUTNYA
  if (children.length > 0) {
    if (children.length === 1) {
      nextStepId = children[0].id;
    } else {
      const selectedChild = children.find(
        (c) =>
          String(c.stepOrder) === normalizedText ||
          (c.stepKey && c.stepKey.toLowerCase() === normalizedText.toLowerCase()),
      );

      if (!selectedChild) {
        const errMsg = "❌ Pilihan tidak valid. Silakan balas dengan angka yang sesuai.";
        await sock.sendMessage(jid, { text: errMsg });
        if (session && session.beSessionId) {
          await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', errMsg);
        }
        updateSession(jid);
        return true;
      }

      if (currentStep.stepKey && currentStep.stepKey !== "main_menu") {
        session.answers[currentStep.stepKey] =
          selectedChild.stepKey || normalizedText;
      }

      nextStepId = selectedChild.id;
    }
  } else {
    let targetNextStepKey = currentStep.nextStepKey;

    if (currentStep.validationRule) {
      let rule = currentStep.validationRule;
      let isValid = true;

      // Cukup gunakan normalizedText karena sudah diekstrak oleh messageMiddleware
      let textToValidate = normalizedText;

      if (rule.startsWith('regex:')) {
        let patternStr = rule.substring(6);
        let pattern = patternStr;
        let flags = '';

        if (patternStr.startsWith('/') && patternStr.lastIndexOf('/') > 0) {
          const lastSlash = patternStr.lastIndexOf('/');
          pattern = patternStr.substring(1, lastSlash);
          flags = patternStr.substring(lastSlash + 1);
        }

        try {
          isValid = new RegExp(pattern, flags).test(textToValidate);

          // CCTV DEBUGGING REGEX
          console.log("=== [DEBUG REGEX] ===");
          console.log("Rule asli:", rule);
          console.log("Pattern diekstrak:", pattern);
          console.log("Teks diuji:", textToValidate);
          console.log("Hasil Validasi:", isValid);
          console.log("=====================");

        } catch (e) {
          console.error("[REGEX_EXEC_ERROR]", e);
          isValid = true;
        }
      } else {
        try {
          isValid = new RegExp(rule).test(textToValidate);
        } catch (e) {
          isValid = true;
        }
      }

      if (!isValid) {
        const errMsg = `⚠️ *Format Tidak Sesuai*\n\nMohon masukkan data sesuai format yang diminta.`;
        await sock.sendMessage(jid, { text: errMsg });
        if (session && session.beSessionId) {
          await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', errMsg);
        }
        return true;
      }
    }

    if (['select', 'confirmation'].includes(currentStep.inputType)) {
      const message = currentStep.messages?.[0];
      const options = message?.metadata?.options || [];

      if (options.length > 0) {
        const matchedOption = options.find(opt =>
          String(opt.option).toLowerCase() === normalizedText.toLowerCase()
        );

        if (matchedOption && matchedOption.nextStepKey) {
          targetNextStepKey = matchedOption.nextStepKey;
        } else {
          const errMsg = "⚠️ Pilihan tidak tersedia. Silakan balas dengan angka yang benar.";
          await sock.sendMessage(jid, { text: errMsg });
          if (session && session.beSessionId) {
            await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', errMsg);
          }
          updateSession(jid);
          return true;
        }
      }
    }

    let forceTicketCreation = false;
    const activeMsg = currentStep.messages?.[0];
    const isInfoOrSuccess = activeMsg && ['info', 'success'].includes(activeMsg.messageType);

    if (!targetNextStepKey) {
      if (isInfoOrSuccess) {
        const text = activeMsg.messageText || "Terima kasih.";
        const finalText = `✅ ${text}`;
        await sock.sendMessage(jid, { text: finalText });
        if (session.beSessionId) {
          await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', finalText);
          await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
        }
        endSession(jid);
        return true;
      }
      forceTicketCreation = true;
    } else {
      const dbNextStep = await getStep(targetNextStepKey);
      if (!dbNextStep) {
        forceTicketCreation = !isInfoOrSuccess;
        if (isInfoOrSuccess) {
          await sock.sendMessage(jid, { text: activeMsg.messageText });
          if (session.beSessionId) {
            await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', activeMsg.messageText);
            await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
          }
          endSession(jid);
          return true;
        }
      } else {
        nextStepId = dbNextStep.id;
      }
    }

    if (forceTicketCreation) {
      await sock.sendMessage(jid, {
        text: "⏳ _Laporan/Data Anda sedang kami proses..._",
      });

      const flowId = currentStep.flowId || null;

      // --- LOGIC EKSTRAK NAMA & LAPORAN ---
      let rawDescription = session.lastReportDescription || normalizedText || "Laporan Warga (Tanpa Deskripsi)";
      let pelaporName = pushName; // Default pakai nama profil WA
      let finalDescription = rawDescription;

      if (rawDescription.includes('#')) {
        // Bersihkan embel-embel foto dari sistem jika ada
        let cleanText = rawDescription.replace('[FOTO TERLAMPIR]', '').trim();
        const parts = cleanText.split('#');

        if (parts.length >= 3) {
          pelaporName = parts[0].trim(); // Ambil NAMA
          finalDescription = parts.slice(2).join('#').trim(); // Ambil sisa teks sebagai LAPORAN murni
        }
      }

      const [userId, categoryId] = await Promise.all([
        getOrCreateUser(phone, pelaporName), // Panggil API pakai nama yang baru diekstrak
        getCategoryIdFromFlow(flowId),
      ]);

      if (!userId || !categoryId) {
        await sock.sendMessage(jid, {
          text: "❌ Maaf, terjadi kendala teknis saat memproses laporan Anda. Silakan coba mulai ulang.",
        });
        if (session.beSessionId) {
          await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
        }
        endSession(jid);
        return true;
      }

      const ticketPayload = {
        description: finalDescription, // Tiket SEKARANG hanya berisi laporannya saja
        userId,
        categoryId,
        sessionId: session.beSessionId,
        ...(session.imageUrl && { imageUrl: session.imageUrl })
      };

      const result = await submitTicket(ticketPayload);
      const closingMsg = adminSettings.SESSION_END_TEXT || "Terima kasih, laporan Anda telah berhasil dicatat.";

      if (result) {
        const finalText = `✅ *BERHASIL*\n\n${closingMsg}`;
        await sock.sendMessage(jid, { text: finalText });
        if (session.beSessionId) {
          await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', finalText);
          await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
        }
      } else {
        const errText = "⚠️ Laporan diterima, namun terjadi kendala saat menyimpan ke sistem. Tim kami akan menindaklanjuti.";
        await sock.sendMessage(jid, { text: errText });
        if (session.beSessionId) {
          await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', errText);
        }
      }

      endSession(jid);
      return true;
    }
  }

  // KONDISI 3: KIRIM STEP SELANJUTNYA
  const rawNext = await getStep(nextStepId);
  const nextStep = rawNext?.data || rawNext;

  if (!nextStep) {
    await sock.sendMessage(jid, {
      text: "Maaf, sistem tidak dapat memuat langkah selanjutnya.",
    });
    return true;
  }

  const nextActiveMsg = nextStep.messages?.[0];
  const isNextInfoOrSuccess = nextActiveMsg && ['info', 'success'].includes(nextActiveMsg.messageType);

  let nextMsg = buildMenuMessage(nextStep);
  if (!nextMsg) nextMsg = "Lanjut ke tahap berikutnya...";

  if (isNextInfoOrSuccess) {
    await sock.sendMessage(jid, { text: nextMsg });
    if (session.beSessionId) {
      await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', nextMsg);
      await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
    }
    endSession(jid);
    return true;
  }

  updateSession(jid, { currentStepId: nextStep.id, answers: session.answers });
  await sock.sendMessage(jid, { text: nextMsg });
  if (session.beSessionId) {
    await logMessageToBackend(session.beSessionId, 'BOT', 'TEXT', nextMsg);
  }
  return true;
};

module.exports = { handleWargaMessage };