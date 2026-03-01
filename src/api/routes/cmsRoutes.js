const express = require('express');
const { getCms, overwriteCms } = require('../controllers/cmsController');

const router = express.Router();

router.get('/', getCms);
router.put('/', overwriteCms);
router.post('/overwrite', overwriteCms);

module.exports = router;
