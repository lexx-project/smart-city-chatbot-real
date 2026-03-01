const express = require('express');
const controller = require('../controllers/adminController');

const router = express.Router();

router.get('/commands', controller.getAdminCommands);
router.get('/admins', controller.listAdmins);
router.post('/admins', controller.addAdmin);
router.delete('/admins/:phone', controller.deleteAdmin);

router.get('/settings', controller.getSettingsOverview);
router.put('/settings/session-end-text', controller.updateSessionEndText);
router.put('/settings/timeout-text', controller.updateTimeoutText);
router.put('/settings/timeout-seconds', controller.updateTimeoutSeconds);

router.put('/main-menu/:menuId/enabled', controller.updateMainMenuEnabled);
router.put('/main-menu/reorder', controller.reorderMainMenu);

router.put('/submenus/:subMenuId/flow-mode', controller.updateSubMenuFlowMode);
router.put('/submenus/:subMenuId/await-timeout', controller.updateSubMenuAwaitTimeout);
router.put('/submenus/:subMenuId/success-reply', controller.updateSubMenuSuccessReply);

router.delete('/sessions/:sessionKey', controller.resetSession);
router.get('/stats/:metric', controller.getStatByRange);

module.exports = router;
