const {
  getSession,
  startSession,
  updateSession,
  endSession,
} = require("../services/wargaSessionService");
const {
  isAdminJid,
  extractPhoneDigits,
} = require("../services/adminService");
const {
  getMainMenu,
  getStep,
  getBotSettings,
  submitTicket,
  getOrCreateUser,
  getCategoryIdFromFlow,
} = require("../services/botFlowService");
const { getAuthenticatedStaff } = require("../services/adminSessionService");


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
        // Ekstrak pola regex (misal dari "regex:/^[0-9]{16}$/" menjadi "^[0-9]{16}$")
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
  return null; // Lolos validasi
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

  const pushName = msg.pushName || "Warga";
  const isAdmin = isAdminJid(sock, jid, pushName);
  const authStaff = getAuthenticatedStaff(jid);
  const isSuperOrAdmin = authStaff && ['ADMIN', 'SUPER_ADMIN'].includes(authStaff.role?.toUpperCase());
  const adminSettings = await getBotSettings();

  // Jika admin mengirim pesan menggunakan prefix '/' (command), biarkan adminController yang menangani.
  if ((isAdmin || isSuperOrAdmin) && bodyText.startsWith("/")) return false;

  const normalizedText = String(bodyText || "").trim();
  if (!normalizedText) return;

  let session = getSession(jid);

  // KONDISI 1: SESI BARU
  if (!session) {
    const rawMenu = await getMainMenu();
    const mainMenu = rawMenu?.data || rawMenu;

    if (!mainMenu || !mainMenu.id) {
      console.error("[WARGA CONTROLLER] API Error: getMainMenu returned null or invalid.");
      if (!isAdmin) {
        await sock.sendMessage(jid, {
          text: "Mohon maaf, layanan sistem sedang mengalami gangguan.",
        });
      }
      return true;
    }

    session = startSession(jid, mainMenu.id);

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
    endSession(jid);
    return true;
  }

  const children = currentStep.children || [];
  let nextStepId = null;

  // Jika ini bukan menu utama, lakukan validasi
  if (currentStep.id !== "root_menu" && currentStep.stepKey !== "main_menu") {
    const isSelectMode = children.length > 1; // Jika pilihan ganda, inputType otomatis select

    if (!isSelectMode) {
      // Validasi Input Teks / Angka
      const errorMsg = validateInput(
        normalizedText,
        currentStep.inputType,
        currentStep.validationRule,
      );
      if (errorMsg) {
        await sock.sendMessage(jid, { text: errorMsg });
        updateSession(jid); // Refresh timer
        return true;
      }
      // Simpan jawaban ke memori
      session.answers[currentStep.stepKey] = normalizedText;
    }
  }

  // TENTUKAN LANGKAH BERIKUTNYA
  if (children.length > 0) {
    if (children.length === 1) {
      nextStepId = children[0].id;
    } else {
      // PILIHAN GANDA (Menu)
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

      // Simpan data pilihan jika diperlukan
      if (currentStep.stepKey && currentStep.stepKey !== "main_menu") {
        session.answers[currentStep.stepKey] =
          selectedChild.stepKey || normalizedText;
      }

      nextStepId = selectedChild.id;
    }
  } else {
    console.log(`\n--- [DEBUG BOT FLOW] ---`);
    console.log(`Step Saat Ini  : ${currentStep.stepKey}`);
    console.log(`NextStepKey DB : ${currentStep.nextStepKey}`);
    console.log(`------------------------\n`);

    let forceTicketCreation = false;

    if (!currentStep.nextStepKey) {
      console.log('[DEBUG] nextStepKey KOSONG (null). Wawancara dianggap selesai, membuat tiket...');
      forceTicketCreation = true;
    } else {
      const dbNextStep = await getStep(currentStep.nextStepKey);
      if (!dbNextStep) {
        console.log(`[DEBUG] ❌ AWAS! nextStepKey '${currentStep.nextStepKey}' TIDAK DITEMUKAN di list Steps! Flow terputus. Memaksa bikin tiket...`);
        forceTicketCreation = true;
      } else {
        console.log(`[DEBUG] ✅ Melanjutkan ke step berikutnya: ${dbNextStep.stepKey}`);
        nextStepId = dbNextStep.id;
      }
    }

    if (forceTicketCreation) {
      // STEP TERAKHIR: Kirim Data ke BE
      await sock.sendMessage(jid, {
        text: "⏳ _Laporan/Data Anda sedang kami proses..._",
      });

      const phone = extractPhoneDigits(jid);
      const flowId = currentStep.flowId || null;

      // Resolve userId dan categoryId secara paralel
      const [userId, categoryId] = await Promise.all([
        getOrCreateUser(phone, pushName),
        getCategoryIdFromFlow(flowId),
      ]);

      if (!userId) {
        console.error('[WARGA_CTRL] Gagal mendapatkan userId. Tiket tidak dikirim.');
        await sock.sendMessage(jid, {
          text: "❌ Maaf, sistem gagal mengidentifikasi akun Anda. Silakan coba lagi dalam beberapa saat.",
        });
        endSession(jid);
        return true;
      }

      if (!categoryId) {
        console.error('[WARGA_CTRL] Gagal mendapatkan categoryId. Tiket tidak dikirim.');
        await sock.sendMessage(jid, {
          text: "❌ Maaf, kategori laporan tidak ditemukan. Silakan coba mulai ulang.",
        });
        endSession(jid);
        return true;
      }

      const ticketPayload = {
        description: JSON.stringify(session.answers, null, 2),
        userId,
        categoryId,
      };

      console.log('[WARGA_CTRL] Mengirim tiket:', JSON.stringify(ticketPayload));

      // Fire and forget ke Backend
      const result = await submitTicket(ticketPayload);

      const closingMsg =
        adminSettings.SESSION_END_TEXT ||
        "Terima kasih, laporan/data Anda telah berhasil dicatat ke dalam sistem.";

      if (result) {
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

  updateSession(jid, { currentStepId: nextStep.id, answers: session.answers });

  let nextMsg = buildMenuMessage(nextStep);
  if (!nextMsg) nextMsg = "Lanjut ke tahap berikutnya...";

  await sock.sendMessage(jid, { text: nextMsg });
  return true;
};

module.exports = { handleWargaMessage };
