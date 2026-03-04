'use strict';

const { nestClient } = require('../api/nestClient');
const { getAdminToken } = require('./adminAuthService');

/**
 * Build an Authorization header with the current admin JWT.
 * Throws if token acquisition fails.
 * @returns {Promise<{ Authorization: string }>}
 */
const authHeader = async () => {
    const token = await getAdminToken();
    if (!token) throw new Error('Gagal mendapatkan token admin');
    return { Authorization: `Bearer ${token}` };
};

/**
 * GET /api/v1/tickets
 * @param {{ status?: string, limit?: number }} params
 */
const getTickets = async (params = {}) => {
    const headers = await authHeader();
    const response = await nestClient.get('/tickets', { params, headers });
    return response.data;
};

/**
 * GET /api/v1/tickets/:id
 * @param {string} id - UUID of the ticket
 */
const getTicketById = async (id) => {
    const headers = await authHeader();
    const response = await nestClient.get(`/tickets/${id}`, { headers });
    return response.data;
};

/**
 * PATCH /api/v1/tickets/:id/status
 * @param {string} id - UUID of the ticket
 * @param {string} status - 'IN_PROGRESS' | 'RESOLVED' | 'REJECTED'
 */
const updateTicketStatus = async (id, status) => {
    const headers = await authHeader();
    const response = await nestClient.patch(`/tickets/${id}/status`, { status }, { headers });
    return response.data;
};

/**
 * GET /api/v1/staff  (or /users?role=staff)
 * Returns the list of staff/dinas available for assignment.
 */
const getStaffList = async () => {
    const headers = await authHeader();
    try {
        // Try dedicated /staff endpoint first
        const response = await nestClient.get('/staff', { headers });
        return response.data?.data || response.data;
    } catch (err) {
        if (err?.response?.status === 404) {
            // Fallback: fetch users with staff/officer role
            const response = await nestClient.get('/users', {
                params: { role: 'STAFF' },
                headers,
            });
            return response.data?.data || response.data;
        }
        throw err;
    }
};

/**
 * Decode the cached admin JWT and return the user's UUID (sub / id field).
 * No extra library needed — just base64-decode the payload segment.
 * Returns null if token is unavailable or malformed.
 */
const getAdminUserId = async () => {
    const token = await getAdminToken();
    if (!token) return null;
    try {
        const payloadB64 = token.split('.')[1];
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
        return payload.sub || payload.id || payload.userId || null;
    } catch {
        return null;
    }
};

/**
 * POST /api/v1/tickets/:id/assign
 * @param {string} ticketId    - UUID of the ticket
 * @param {string} assignedTo  - UUID of the staff to assign
 * @param {string} assignedBy  - UUID of the admin performing the assignment
 */
const assignTicket = async (ticketId, assignedTo, assignedBy) => {
    const headers = await authHeader();
    const response = await nestClient.post(
        `/tickets/${ticketId}/assign`,
        { assignedTo, assignedBy },
        { headers }
    );
    return response.data;
};

module.exports = { getTickets, getTicketById, updateTicketStatus, getStaffList, assignTicket, getAdminUserId };
