const { loadCmsData, saveCmsData } = require('../../services/cmsService');

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const validateCmsPayload = (payload) => {
    if (!isObject(payload)) return 'Body harus object JSON.';
    const requiredKeys = ['greetingMessage', 'mainMenu', 'subMenus', 'timeoutSeconds'];
    for (const key of requiredKeys) {
        if (!(key in payload)) return `Field wajib tidak ada: ${key}`;
    }
    if (!Array.isArray(payload.mainMenu)) return 'mainMenu harus array.';
    if (!isObject(payload.subMenus)) return 'subMenus harus object.';
    if (!Number.isFinite(Number(payload.timeoutSeconds)) || Number(payload.timeoutSeconds) <= 0) {
        return 'timeoutSeconds harus angka > 0.';
    }
    return null;
};

const getCms = async (req, res) => {
    try {
        const data = await loadCmsData();
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal membaca CMS.', error: error.message });
    }
};

const overwriteCms = async (req, res) => {
    try {
        const payload = req.body;
        const validationError = validateCmsPayload(payload);
        if (validationError) {
            return res.status(400).json({ success: false, message: validationError });
        }

        await saveCmsData(payload);
        const latest = await loadCmsData();
        return res.status(200).json({ success: true, message: 'CMS berhasil diperbarui.', data: latest });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Gagal memperbarui CMS.', error: error.message });
    }
};

module.exports = {
    getCms,
    overwriteCms,
};
