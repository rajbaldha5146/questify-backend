const rateLimit = require("express-rate-limit");

// Disabled rate limiter for development - just pass through
const createDisabledLimiter = () => {
  return (req, res, next) => {
    next(); // Just pass through without any limiting
  };
};

// Disabled for development
const aiOperationsLimiter = createDisabledLimiter();
const generalLimiter = createDisabledLimiter();

module.exports = {
  aiOperationsLimiter,
  generalLimiter,
};
