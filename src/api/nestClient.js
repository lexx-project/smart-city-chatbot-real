const DEFAULT_TIMEOUT_MS = 10000;

const getBaseUrl = () => {
    const raw = process.env.NEST_API_BASE_URL || 'http://localhost:3000';
    return String(raw).replace(/\/+$/, '');
};

const buildUrl = (path) => {
    const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${String(path || '')}`;
    return `${getBaseUrl()}${normalizedPath}`;
};

const request = async (method, path, options = {}) => {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(buildUrl(path), {
            method,
            headers: {
                Accept: 'application/json',
                ...(options.headers || {}),
            },
            signal: controller.signal,
        });

        const text = await response.text();
        let data = null;

        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
        }

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status} ${response.statusText}`);
            error.status = response.status;
            error.data = data;
            throw error;
        }

        return {
            data,
            status: response.status,
        };
    } catch (error) {
        if (error?.name === 'AbortError') {
            const timeoutError = new Error(`Request timeout after ${timeoutMs}ms`);
            timeoutError.code = 'REQUEST_TIMEOUT';
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
};

const get = async (path, options = {}) => request('GET', path, options);

module.exports = {
    get,
};
