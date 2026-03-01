const express = require('express');
const { getRealtimeAnalytics, getAnalyticsSummary } = require('../controllers/analyticsController');

const router = express.Router();

router.get('/realtime', getRealtimeAnalytics);
router.get('/summary', getAnalyticsSummary);

module.exports = router;
