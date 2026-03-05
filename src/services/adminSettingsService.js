const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../admin_settings.json');

const loadSettings = () => {
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        } catch (e) {
            console.error('Failed to parse admin_settings.json:', e);
            return { timeoutSeconds: 300 }; // Default 5 minutes
        }
    }
    return { timeoutSeconds: 300 };
};

const saveSettings = (settings) => {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
};

const getAdminTimeout = () => {
    return loadSettings().timeoutSeconds || 300;
};

const getAdminTimeoutText = () => {
    return loadSettings().timeoutText || '⏳ _Sesi Anda telah berakhir karena tidak ada respons selama beberapa waktu. Ketik /setting untuk memulai ulang._';
};

const updateAdminTimeout = (seconds) => {
    const settings = loadSettings();
    settings.timeoutSeconds = parseInt(seconds, 10);
    saveSettings(settings);
};

const updateAdminTimeoutText = (text) => {
    const settings = loadSettings();
    settings.timeoutText = text;
    saveSettings(settings);
};

module.exports = { getAdminTimeout, getAdminTimeoutText, updateAdminTimeout, updateAdminTimeoutText };
