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

  // 1. SETOR CHAT (Biar Kategori/History masuk ke Dashboard)
  await logMessageToBackend(phone, normalizedText);

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

    let msgToSend = adminSettings.GREETING_MSG
      ? `${adminSettings.GREETING_MSG}\n\n`
      : "";
    msgToSend += buildMenuMessage(mainMenu);

    await sock.sendMessage(jid, { text: msgToSend });
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

  if (currentStep.id !== "root_menu" && currentStep.stepKey !== "main_menu") {
    const isSelectMode = children.length > 1;

    if (!isSelectMode) {
      let finalAnswer = normalizedText;
      let errorMsg = null;

      // Cek apakah pesan yang masuk adalah gambar
      const rawMsg = unwrapMessage(msg?.message || {});
      const isImage = !!rawMsg?.imageMessage;

      // BYPASS: Jika inputType "number" TAPI user mengirim gambar
      if (currentStep.inputType === "number" && isImage) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
          const fileName = `evidence_${Date.now()}.jpg`;
          const uploadDir = path.join(process.cwd(), 'uploads');

          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }

          fs.writeFileSync(path.join(uploadDir, fileName), buffer);
          finalAnswer = `[LAMPIRAN FOTO] ${fileName}`;
        } catch (err) {
          console.error("[DOWNLOAD_ERROR]", err);
          errorMsg = "⚠️ Gagal menyimpan gambar. Silakan coba kirim ulang.";
        }
      } else {
        // Jika bukan gambar, jalankan validasi normal
        errorMsg = validateInput(
          normalizedText,
          currentStep.inputType,
          currentStep.validationRule,
        );
      }

      if (errorMsg) {
        await sock.sendMessage(jid, { text: errorMsg });
        updateSession(jid);
        return true;
      }

      // Simpan jawaban (teks normal atau nama file gambar)
      session.answers[currentStep.stepKey] = finalAnswer;
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
        await sock.sendMessage(jid, {
          text: "❌ Pilihan tidak valid. Silakan balas dengan angka yang sesuai.",
        });
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
          isValid = new RegExp(pattern, flags).test(normalizedText);
        } catch (e) {
          isValid = true;
        }
      } else {
        try {
          isValid = new RegExp(rule).test(normalizedText);
        } catch (e) {
          isValid = true;
        }
      }

      if (!isValid) {
        await sock.sendMessage(jid, {
          text: `⚠️ *Format Tidak Sesuai*\n\nMohon masukkan data sesuai format yang diminta.`
        });
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
          await sock.sendMessage(jid, { text: "⚠️ Pilihan tidak tersedia. Silakan balas dengan angka yang benar." });
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
        if (session.beSessionId) {
          await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
        }
        await sock.sendMessage(jid, { text: `✅ ${text}` });
        endSession(jid);
        return true;
      }
      forceTicketCreation = true;
    } else {
      const dbNextStep = await getStep(targetNextStepKey);
      if (!dbNextStep) {
        forceTicketCreation = !isInfoOrSuccess;
        if (isInfoOrSuccess) {
          if (session.beSessionId) {
            await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
          }
          await sock.sendMessage(jid, { text: activeMsg.messageText });
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

      const [userId, categoryId] = await Promise.all([
        getOrCreateUser(phone, pushName),
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
        description: JSON.stringify(session.answers, null, 2),
        userId,
        categoryId,
      };

      const result = await submitTicket(ticketPayload);
      const closingMsg = adminSettings.SESSION_END_TEXT || "Terima kasih, laporan Anda telah berhasil dicatat.";

      if (result) {
        if (session.beSessionId) {
          await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
        }
        await sock.sendMessage(jid, { text: `✅ *BERHASIL*\n\n${closingMsg}` });
      } else {
        await sock.sendMessage(jid, {
          text: "⚠️ Laporan diterima, namun terjadi kendala saat menyimpan ke sistem. Tim kami akan menindaklanjuti.",
        });
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
    if (session.beSessionId) {
      await endRemoteSession(session.beSessionId).catch(err => console.error("[REMOTE_SESSION] Gagal tutup:", err.message));
    }
    await sock.sendMessage(jid, { text: nextMsg });
    endSession(jid);
    return true;
  }

  updateSession(jid, { currentStepId: nextStep.id, answers: session.answers });
  await sock.sendMessage(jid, { text: nextMsg });
  return true;
};

module.exports = { handleWargaMessage };