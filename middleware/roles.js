/**
 * Role-Based Access Control Middleware
 * 4-tier: super_admin(4) > admin(3) > accountant(2) > viewer(1)
 */
const ROLE_HIERARCHY = {
  super_admin: 4,
  admin: 3,
  accountant: 2,
  viewer: 1
};

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole) {
      return res.status(403).json({ code: 403, message: '无权限：未分配角色' });
    }
    const userLevel = ROLE_HIERARCHY[userRole] || 0;
    const minAllowed = Math.min(...allowedRoles.map(r => ROLE_HIERARCHY[r] || 0));
    if (userLevel < minAllowed) {
      return res.status(403).json({ code: 403, message: '无权限' });
    }
    next();
  };
}

module.exports = { requireRole, ROLE_HIERARCHY };
