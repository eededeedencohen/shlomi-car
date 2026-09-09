import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/authController.js';

const router = express.Router();

router.post('/login', ctrl.login);
router.get('/me', protect, ctrl.me);
router.post('/change-password', protect, ctrl.changePassword);

export default router;
