const express = require('express');
const adminRoutes = require('./adminRoutes');

const router = express.Router();

router.get('/health', (req, res) => {
    res.status(200).json({ success: true, message: 'API OK' });
});

router.use('/admin', adminRoutes);

module.exports = router;
