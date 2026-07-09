/**
 * Account Set Middleware
 * Resolves current account_set_id from request header/cookie and attaches to req
 */
module.exports = function accountSet(req, res, next) {
  // Priority: header > cookie > default
  const headerVal = req.headers['x-account-set'];
  if (headerVal) {
    req.accountSetId = parseInt(headerVal, 10) || 1;
    return next();
  }

  // Try cookie
  if (req.cookies && req.cookies.account_set_id) {
    req.accountSetId = parseInt(req.cookies.account_set_id, 10) || 1;
    return next();
  }

  // Default to 1
  req.accountSetId = 1;
  next();
};
