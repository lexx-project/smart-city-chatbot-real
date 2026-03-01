const express = require('express');
const cmsRoutes = require('./cmsRoutes');
const analyticsRoutes = require('./analyticsRoutes');
const adminRoutes = require('./adminRoutes');

const router = express.Router();

router.get('/health', (req, res) => {
    res.status(200).json({ success: true, message: 'API OK' });
});

router.use('/cms', cmsRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/admin', adminRoutes);

module.exports = router;
